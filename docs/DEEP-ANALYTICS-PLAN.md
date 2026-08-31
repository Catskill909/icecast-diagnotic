# Deep analytics — the full build, with limits shown

> Planning document, 2026-08-31. The decision behind it: **go as deep as the data
> allows, and put every limitation on screen rather than dropping the metric.**
>
> Companions: [`ADMIN-ACCESS-SCOPE.md`](ADMIN-ACCESS-SCOPE.md) (what a credential
> unlocks), [`AUDIENCE-ROADMAP.md`](AUDIENCE-ROADMAP.md) (vocabulary and phasing).

---

## 1. The principle, and the one thing it does not license

**Show the caveat, keep the metric.** A number with a stated limitation is more
useful than no number, *provided the limitation travels with it everywhere it is
shown* — not in a tooltip, not in a footnote on another page.

This is already how the system behaves and it is worth naming so it is applied
deliberately rather than rediscovered:

- ATH ships labelled *estimated*, in the panel body, because someone will
  eventually be tempted to file a royalty return on it.
- Individual listeners is shown as a card reading *unavailable for this server*
  rather than hidden, so the page does not change shape per station.
- The reach comparison is **withheld** when the earlier window was only partly
  recorded, and says so, rather than printing a percentage that is an artefact.

**The non-goal, stated so it is never drifted into: identifying individuals.**
Not device fingerprints, not per-listener rows in any response, not a dot on a
map. Everything below is a distribution, a count or a rate. Where a metric can
only be built by identifying someone, it is not built.

---

## 2. Confidence is a system, not a sentence per panel

Today's provenance flags are ad hoc — `estimated: true`, `floor: true`,
`hoursMissing`, `totalListenersComparable`, an `unavailable` block — four shapes
meaning related things, each rendered differently. Going deeper multiplies that
into a mess unless it is made a system first.

**Every metric carries the same envelope:**

```js
{
  value: 4123,
  confidence: 'measured',       // see the vocabulary below
  basis: 'session',             // what it was computed from
  caveats: ['proxied-audience'],// stable ids, not prose
  coverage: { of: 168, have: 168, unit: 'hours' },
}
```

### The vocabulary — six words, fixed

| `confidence` | Means | Rendered as |
|---|---|---|
| `measured` | Counted directly from records of the thing itself | no qualifier |
| `estimated` | Derived by inference from something adjacent | **estimated** beside the figure |
| `floor` | A true value that is **at least** this — under-counts by construction | **at least** prefix |
| `partial` | Correct for the span actually recorded, which is less than the period asked for | coverage stated inline |
| `proxy` | Measures a stand-in, not the thing named — closest available answer | **proxy for X** beside the figure |
| `unavailable` | Cannot be produced; the reason is the content of the card | reason shown, slot kept |

**A comparison inherits the weakest confidence of its two periods.** This is the
rule the tune-in bug violated: this week `measured` against last week `partial`
produced "▼97.1%", which was entirely an artefact of the older window. **A
percentage between periods of unequal confidence is withheld, not shown.**

### Caveats are ids, not prose

`caveats: ['proxied-audience']` resolves to one canonical explanation, written
once. Prose per panel means the same limitation described three ways, and drift
the moment one is edited. It also means a caveat can be counted, filtered and
surfaced in an export — a CSV whose numbers carry their own qualifications.

---

## 3. Distribution channel — a first-class metric

**How the audience reaches the station, not just how many.** For public radio
this is a strategic question nobody currently answers, and it also decides how
much every other figure on the page can be trusted.

### Why it matters twice

**Strategically.** "38% of our listening arrives through TuneIn" changes where a
station spends effort, what it negotiates, and what happens if an aggregator
delists it. That is a board-meeting number and it is invisible today.

**Methodologically.** An aggregator that **proxies** relays one connection on
behalf of many listeners. Every count the app publishes — concurrent, tune-ins,
ATH, the royalty estimate — then understates the true audience by an unknown
factor. **Knowing the proxied share is what tells you how wrong everything else
is**, which makes this the highest-value metric in this document even though it
sounds like a minor breakdown.

### How to detect it

Three signals, none conclusive alone, strong together:

| Signal | Reads as an aggregator when |
|---|---|
| **User agent** | it names one — `TuneIn`, `iHeart`, `Radio Garden`, `Streema` |
| **ASN** (`GeoLite2 ASN`, free, separate database) | the address belongs to a **hosting provider**, not a consumer ISP |
| **Connection shape** | one address holding a very long session, reconnecting rarely — a relay stays up while any listener is on, which no person does |

**`GeoLite2 ASN` is the quiet workhorse of this whole document.** The same free
account, a much smaller file than the City database, and it separates datacenter
from residential addresses. That single distinction powers aggregator detection,
bot filtering, VPN identification, **and** it explains a geography anomaly that
would otherwise be reported as a finding: a datacenter IP geolocates to the
datacenter, so proxied listening piles up wherever the relay is hosted.

### What is reported

- **Share of listening by channel** — direct, per named aggregator, unclassified.
- **Proxied share**, prominently, as the qualifier on every other audience figure
  on the page. If it is high, the page says so at the top rather than in §7 of a
  methodology note.
- **What proxying costs us**, stated plainly: behind a relay there is no device,
  no location, no session length, and no listener count. It is one connection.

**A proxied listener is not a lost listener — it is an uncounted one.** The
distinction has to be in the copy, or a station will read a high proxied share as
an audience decline.

---

## 4. The metric catalogue

`✓` needs nothing new · `A` admin credential · `G` GeoLite2 City · `N` GeoLite2 ASN

### 4.1 Audience size

| Metric | Needs | Confidence | Travelling caveat |
|---|---|---|---|
| Concurrent listeners, peak, floor | ✓ | `measured` | brief overlaps invisible between checks |
| Tune-ins / total listeners | ✓ | `floor` | rises between polls only; simultaneous arrival and departure cancels |
| Tune-ins, exact | A | `measured` | proxied audience uncounted |
| Individual listeners | A | `proxy` | IP + agent: a household behind one NAT is one; one person on phone and laptop is two |
| ATH | ✓ | `estimated` | polled counts, not connection logs — not filing-grade |
| ATH, real | A | `measured` | proxied audience uncounted |

### 4.2 Engagement

| Metric | Needs | Confidence | Travelling caveat |
|---|---|---|---|
| Session length / TSL | A | `measured` | sessions open at period end are right-censored — report median, not mean |
| Session length distribution | A | `measured` | same |
| Return rate | A | `proxy` | same IP + agent later ≠ same person |
| Programme-level audience | ✓ **(!)** | `measured` | title is what the encoder reports; blank or stale during automation |

> **Programme-level audience needs no credential.** The now-playing title is read
> on every check and **discarded** — samples do not store it. Storing one string
> per sample yields "which show holds its audience", the question a programme
> director actually asks, from data already being fetched. **This is the cheapest
> high-value metric in this document and it is available today.**

### 4.3 Who and where

| Metric | Needs | Confidence | Travelling caveat |
|---|---|---|---|
| Country breakdown | A + G | `measured` | ~99% accurate |
| US state / metro | A + G | `estimated` | mobile carrier NAT resolves to regional gateways; `accuracy_radius` gates it |
| In-market vs out-of-market share | A + G | `estimated` | same — the headline geographic number, one per station |
| Non-US, below country | — | `unavailable` | accuracy too variable by region to publish (see scope doc) |
| Player / app family | A | `measured` | generic library agents are an honest unknown bucket |
| Platform, OS | A | `measured` | absent from some agents |
| Device model, where offered | A | `partial` | Android and Sonos only |
| Smart speaker breakdown | A | `partial` | Sonos and Chromecast identifiable; **Alexa usually arrives via TuneIn and is not separable** |
| Bot / datacenter share | A + N | `measured` | excluded from audience figures, reported separately |

### 4.4 Diagnosis — what only this system can do

| Metric | Needs | Confidence | Why nobody else has it |
|---|---|---|---|
| Audience retained through an outage | A | `measured` | needs the outage record and the audience curve in one store |
| Reconnection time after recovery | A | `measured` | same |
| Which players fail to recover unattended | A | `measured` | needs sessions **and** outages |
| Loss by fault owner (KPFT vs Pacifica) | ✓ | `measured` | the classifier already assigns it |
| Per-mount audience trend | ✓ | `partial` | rollups compact the per-mount split away after retention |

---

## 5. Collection and storage

**Two loops, different cadences, deliberately not shared.**

| Loop | Every | Why |
|---|---|---|
| Status poll | 60 s | unchanged: concurrent counts, mount health, dead air, the alert gate |
| Session poll | 5 min | `Connected` gives duration directly, so minute resolution buys nothing and costs fivefold volume |

**Aggregate on arrival.** Raw per-connection rows are read, classified
(player, platform, channel, ASN class, geo bucket), folded into counters, and
**discarded**. What persists is distributions, not people. This is a privacy
control and a storage control at once — it is what stops ~630,000 rows a day
becoming the storage problem the naive design has.

**Sessions are the exception** and need a short-lived working set: a session's
duration is only known when it ends, so open sessions are held keyed by
connection id until they close or age out. **Hours, not months.**

**This is where SQLite arrives.** `HANDOFF.md` §5 says revisit at ~50 mounts or
when per-listener analytics begins, whichever comes first. This is that — decide
before collection starts, because migrating a schema with a month of data in it
is the expensive path.

**Our own probes become identifiable rows** and can finally be excluded exactly
rather than avoided by careful ordering. Expect published figures to move
slightly; that correction is a result worth stating, not hiding.

---

## 6. Privacy, as a design constraint rather than a review step

1. **No response, ever, contains a per-listener row.** Not an IP, not a
   coordinate, not a raw agent string. Aggregation happens server-side, before
   serialisation.
2. **Raw rows live for hours, aggregates for ever.**
3. **Suppress small cells.** A country with one listener is a person, not a
   statistic. Below a threshold — five is conventional — report "other" rather
   than a count of one. A single listener in a small country is identifying.
4. **The GeoIP licence key is a secret**, stored with the Icecast credential
   under the same allowlist redaction.
5. **EU listeners raise the legal bar** and `GeoLite2` carries the flag to know
   whether they exist.

**The obvious implementation of every panel here — fetch rows, send to the
browser, group in the chart — publishes every listener's IP to anyone who loads
the page.** This codebase shipped that class of leak three times on 2026-08-31
alone. The aggregation boundary is the whole defence.

---

## 7. Build order

> Phase boundaries and everything outside analytics are in
> [`PHASE-PLAN.md`](PHASE-PLAN.md). This is the detailed order **within** Phases
> 2 and 5 of it, and it supersedes the list in `ADMIN-ACCESS-SCOPE.md` §7.

**Now, no credential.**

| | | Why here |
|---|---|---|
| 1 | **Confidence envelope + caveat registry** | Everything after it renders through this. Retrofitting it later means editing every panel twice |
| 2 | **Programme-level audience** — store the title | Cheapest high-value metric here; the data is already fetched and thrown away |
| 3 | Day-of-week × hour heatmap; per-mount trend | Outstanding Phase 1 items |
| 4 | Migrate existing flags to the envelope | `estimated`, `floor`, `hoursMissing`, `Comparable` become one shape |

**On a credential.**

| | | Why here |
|---|---|---|
| 5 | **Read `listclients` raw** | Every design assumes a field shape the docs do not document |
| 6 | **Storage + retention decision** | Before collection. Not after |
| 7 | Credential per host, panel-entered, allowlist-redacted | Already designed |
| 8 | Session collection, aggregate-on-arrival | The base everything below reads |
| 9 | **Distribution channel + ASN classification** | §3. Do this **before** publishing any figure derived from sessions, or the proxied-share correction lands publicly afterwards |
| 10 | Bot filtering; exclude our own probes | Same reason — corrections before publication |
| 11 | TSL, session distribution, player breakdown | The engagement block |
| 12 | Exact tune-ins, real ATH | Upgrades two existing figures from estimate to measurement |
| 13 | Audience retained through an outage | The one nobody else can build |
| 14 | Geography — in-market share, then country, then state | Needs the City database and a deployment change |

**Steps 1, 6 and 9 are the load-bearing ones.** The rest is ordinary work.

---

## 8. What stays impossible, and should be said so

- **Individual device or person identity.** Explicit non-goal, not an unmet
  ambition.
- **Demographics.** Age, gender, income are not in any of this data. Any panel
  implying them would be invention.
- **Listeners behind a proxying aggregator**, individually. One connection is one
  connection; the audience behind it is unknowable from our side at any depth.
- **Non-US sub-country geography**, to a standard worth publishing.
- **Whether someone is actually listening.** An open connection is an open
  connection — a stream left playing to an empty room counts. Every audience
  figure in this document inherits that, and it is the oldest limitation in
  broadcast measurement rather than a flaw in this design.
