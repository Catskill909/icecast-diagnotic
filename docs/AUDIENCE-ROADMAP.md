# Audience analytics — where the page goes next

**Researched 2026-08-28.** Sources at the end. Figures quoted from
SoundExchange are a snapshot and must be re-checked before anyone relies on
them for a filing.

---

## 1. The one question everything divides on

Every feature below falls on one side or the other of a single line:

> **Do we have Icecast *admin* credentials for the Pacifica host?**

That is already open question #4 in [`HANDOFF.md`](../HANDOFF.md) §10. The
research turns it from a curiosity into **the highest-leverage unknown in the
project**, because it decides which half of the industry-standard metric set is
buildable at all.

### What we can build from what we already collect

We poll `/status-json.xsl` every 60 seconds. That returns **counts** — how many
listeners are on each mount right now. From counts alone:

| Metric | Status |
|---|---|
| Concurrent listeners, peak, average | ✅ built |
| Per-mount / per-bitrate split | ✅ built — **nobody else has this** |
| Hour-of-day profile | ✅ built |
| **ATH / Total Listening Hours** | ⚠️ `store.getListeningDelivered()` already computes listener-minutes. Not exported, not surfaced. **One export away.** |
| Day-of-week × hour heatmap | buildable now |
| Channel-vs-channel comparison, trend vs previous period | buildable now |
| Audience retained through an outage | buildable now — we have the outage record beside the audience |

### What is impossible without admin credentials

These need per-listener records, which counts cannot give at any polling rate:

| Metric | Needs |
|---|---|
| **Unique listeners** | IP + user-agent pair per connection |
| **Session length / TSL** | connection start and end per listener |
| **Geography** (country, city) | listener IP → geo lookup |
| **Device / player / browser** | user-agent string |
| **Referrer** | request headers |

`/admin/listclients?mount=/live_128` returns exactly this, as XML, per mount.
The Icecast docs do not enumerate the fields — the way to find out is to request
the endpoint without the `.xsl` suffix and read the raw document.

**So: one credential unlocks roughly half of what the commercial panels sell.**
Getting it is worth more than any amount of charting work on the data we have.

---

## 1.5 Vocabulary — and why these are not the same number

Most confusion about audience figures is one of these five words being used for
another. They differ by more than definition: they differ by what data can
produce them at all.

| Term | What it counts | Needs | Status |
|---|---|---|---|
| **Concurrent listeners** | Connections open at one instant | A count, polled | ✅ built |
| **Peak concurrent** | The largest that number ever got | Same | ✅ built |
| **Total listeners / tune-ins** | How many times someone *started* listening | Every RISE in the count is an arrival | ✅ built, a floor |
| **Individual listeners** | How many different people, however often each tuned in | Identity per connection (IP + user agent) | ❌ admin |
| **ATH / listening hours** | Total time delivered, all listeners summed | Counts × elapsed time | ⚠️ built, estimated |

The one that catches people out:

> **One person who tunes in ten times is TEN total listeners and ONE individual
> listener.**

Neither is "peak 178". That is how many were connected at the same moment.

**This distinction is not academic — it is the difference between a station
looking small and looking its actual size.** Measured on the production record:
844 people tuned in today against a concurrent peak of 178, and 1,269 against
193 on the busiest day — **four to nine times larger**. A listener-supported
station quoting the concurrent figure in a pledge drive, a CPB report or an
underwriting pitch understates itself by that factor, to precisely the audiences
whose decisions turn on the number.

Reach is the mission figure. Concurrency is a fact about server load.

### How tune-ins are derived without per-listener data

Every RISE in the listener count is somebody starting to listen. Summing the
rises over a period counts arrivals without needing to know who anyone is.

It is a **floor**. Within one 60-second cycle, three people leaving as three
arrive is a net change of zero and is invisible, so the true number is higher —
never lower. Rises across a monitoring gap are excluded: an audience becoming
visible again after an outage is not an audience arriving, and counting it would
invent a surge on exactly the days a station already had a bad time.

Each hour's tune-ins are frozen onto its rollup when raw samples compact, because
an hourly average cannot show that forty listeners left as forty arrived. Miss
that window and the churn is gone for good.

### The distinct-listener caveat, for when we can compute it

Even with admin access, "unique listeners" is a **proxy, not a headcount of
humans**. The industry definition — Radio Mast states it explicitly — is a
unique combination of **IP address and user agent**. That means:

- A household, an office or a mobile carrier behind one NAT address collapses
  **several people into one**.
- One person listening on a phone and a laptop counts as **two**.

It is still the best available reach figure and worth having. But if a station
puts it in a funding pitch, the caveat travels with it — which is why it should
be labelled in the UI when it arrives, exactly as ATH is labelled an estimate
now.

## 2. What the market actually offers

Surveyed: Radio Mast, AzuraCast, Centova Cast, Live365, MediaCP.

**The standard metric set.** Listener sessions · active/concurrent sessions ·
uniques (defined as a unique user-agent + IP pair) · TLH/ATH · average session
duration · play count · performances (one airing × ten listeners = ten
performances) · tracks per hour.

**The standard breakdowns.** Country · city · device · referrer · user agent.
Radio Mast shows top-5 series on graphs and top-10 in tables, with 15-minute,
hourly or daily resolution and a percentage mode.

**The standard reports.** SoundExchange (monthly), ASCAP and BMI (quarterly),
Re:Sound, NPR Cadence, and raw log archiving.

**What station managers say they actually watch:** concurrent listeners, peak
concurrent, average session duration, and TSL. Reach metrics (uniques, CUME)
answer "how many people"; TSL and concurrency answer "how engaged" — and for a
listener-supported station the second question is the one tied to money.

**Notable feature nobody in this space does badly:** AzuraCast reports *each
song's impact on listener count*. We cannot do that yet — we do not retain
now-playing metadata against the audience curve, though we already read the
title on every check and could start.

---

## 3. The feature that matters most, and why

**Aggregate Tuning Hours against the SoundExchange threshold.**

ATH is defined as one person listening for one hour. It is not just an
engagement metric for a US noncommercial broadcaster — it is the number the
royalty rate is computed from:

- **Noncommercial Webcaster (CRB):** $1,000/yr covers each channel's first
  **159,140 ATH per month**. Above that, additional fees apply.
- **Noncommercial Educational Webcaster:** the annual fee likewise covers
  159,140 ATH/month.
- **Noncommercial Microcaster:** under **44,000 ATH per year** pays a flat $500,
  and for $100 more can waive Reports of Use entirely.

Pacifica stations are noncommercial. So there is a number, with dollars attached
and a hard threshold, that **we can already compute from data we have been
collecting since 4 August** — and which no general-purpose Icecast panel frames
against the allowance. They report the figure; they do not tell you how close to
the cliff you are.

> **"KPFT Main is at 61% of its 159,140 ATH allowance with 9 days of the month
> left."**

That is the single highest-value thing this page could say, it needs no new data
collection, and it is the sentence that makes a GM open it.

### The honesty requirement

Our ATH is **estimated from 60-second polling**, not a census of connections.
`getListeningDelivered()` weights each sample by the median inter-sample gap,
which is a sound estimator but is not what a per-connection log would produce.

Any figure shown against a royalty threshold **must be labelled an estimate**,
with its method stated. Shipping an unqualified number that a station files on
would be the most damaging thing on this page. It is fine — arguably ideal — as
an early-warning indicator: "you are approaching the threshold, go and get the
real figure."

---

## 4. Proposed build order

**Phase 1 — from data we already have.** No new collection, no credentials.

1. ✅ **SHIPPED 2026-08-28. ATH / listening hours**, per channel, month-to-date
   against the 159,140 threshold, projected to month end, with an explicit
   "estimated" label in the panel itself rather than only in a popover.
   Measured on real data: KPFT Main runs ≈39,100 ATH/month, about 25% of the
   allowance. The month runs on the STATION's clock, and the projection is rated
   over the span actually watched rather than the elapsed month — a monitor that
   started mid-month would otherwise project roughly two-thirds too low, on the
   one number whose entire purpose is warning about a threshold.
2. 🔶 **Day-of-week × hour heatmap.** A day-by-day table shipped 2026-08-28
   (average / peak / low / hours per day), which already shows the effect on
   real data — weekends average 69–78 against 43–47 on Monday and Tuesday. The
   full hour × weekday grid is still to do.
3. ✅ **SHIPPED 2026-08-28. Listener NUMBERS, and trend against the previous
   period.** This is the page's headline; listening hours sit below it. Note what
   is still *not* answerable: a count of distinct people needs per-listener
   records, so the card for it says "unavailable for this server" rather than
   showing a concurrent figure under a name that would misdescribe it. Withheld —
   null, not zero — unless we watched for the whole of the earlier window, because
   a monitor running four days comparing week against week reports a collapse in
   listening that only happened to the recording.

   **REWRITTEN 2026-09-01 to ROLLING WINDOWS.** It first shipped as calendar
   periods — today, this week, this month — each against the same elapsed span of
   the period before. A calendar period spends most of its life partly elapsed,
   and on 1 September the page read **415 for "This month" beside 1,809 for "This
   week"**: a month smaller than the week inside it, correct to the hour, and read
   by the operator and everyone he showed it to as catastrophic data loss.

   The cards are now **Last 24 hours / Last 7 days / Last 30 days**, each against
   the window of equal length immediately before it. `30d ⊇ 7d ⊇ 24h` always, so
   the figures are monotonic by construction and no card can report less than the
   one inside it. It also retired the whole timezone class of bug — a rolling
   window is the same span in every zone, so an all-stations total can no longer
   fall below one of its members. Calendar months did not go away; they moved to
   where naming the period is the point (item 6 below).

6. **Month-to-month, by name — "September vs October".** ← NOT YET BUILT.
   The rolling cards deliberately cannot answer this: "last 30 days" is a moving
   window, and a GM preparing a board report, a pledge drive or a funder update
   asks about a NAMED month. The data supports it already — hourly rollups are
   never deleted, so any past month stays readable indefinitely — but nothing in
   the app builds the comparison.

   **Entry condition: two COMPLETE calendar months.** Recording began
   2026-08-04, so August is partial and cannot be a term in an honest comparison.
   September is the first complete month; October is the second. **The first
   truthful month-vs-month comparison is October vs September, available
   2026-11-01.** Building it earlier is fine; shipping a comparison whose earlier
   term is a partial month is the `+376%` artefact wearing a different label.

   Three rules it inherits, none of them optional:
   - A month is bounded on the **station's own clock** (`monthStartMs`), not UTC.
   - Both terms must be **fully recorded**, or the percentage is withheld —
     the same gate the rolling cards use.
   - A month older than `SAMPLE_RETENTION_DAYS` is hourly-rollup data, so a
     month-vs-month peak is a peak HOUR on both sides. Compare like with like or
     say which it is; do not put an hourly peak in a ratio with a minute peak.
4. **Audience retained through an outage.** We hold the outage record and the
   audience curve in the same store; nobody else can join those two.
5. **Per-mount trend over time**, not just the current split — does the
   low-bitrate variant's share move?

**Phase 2 — needs admin credentials. UNBLOCKED 2026-09-02:** Pacifica issued an
admin credential for `streams.pacifica.org:9000`, so the credential this phase
was waiting for now exists. See `ADMIN-ACCESS-SCOPE.md` §0 for where the secret
lives and what still has to be answered before collection starts — notably §4.2
below, which was allowed to stay undecided only while there was nothing to
collect.

> **Scoped in full in [`ADMIN-ACCESS-SCOPE.md`](ADMIN-ACCESS-SCOPE.md)** —
> what each `listclients` field unlocks, the listener-map question answered, the
> storage and privacy decisions that must be made before collection starts, and
> a build order. Verified there: both production hosts already answer
> `/admin/listclients` with **401**, so the whole of Phase 2 is gated on one
> credential and nothing else.

One endpoint unlocks all of it. `/admin/listclients?mount=/live_128` returns a
row per connected listener; the Icecast docs do not enumerate the fields, so the
first task is to request it without the `.xsl` suffix and read the raw XML. From
those rows, in rough order of value:

6. ✅ **SHIPPED 2026-08-28 in estimated form. Total listeners / tune-ins**, from
   rises in the listener count — a floor, needing no credentials at all. Admin
   access would upgrade it from a floor to an exact count by making each
   connection individually visible, but the figure exists and leads the page now.
7. **Session length and TSL.** Falls out of the same diffing: how long each
   connection persisted. TSL is the engagement metric station managers say they
   actually watch.
8. **Distinct listeners / reach**, deduplicated on IP + user agent — with the
   caveat in §1.5 attached wherever it is shown.
9. **Device, player and browser breakdown**, from the user-agent string. Cheap
   once the rows are being collected, and it answers a real operational question:
   which players are people using, and does the stream work in them.
10. **Geography.** See the dependency below — this one is not just a chart.
11. **Real, non-estimated ATH**, summed from actual session durations rather than
    inferred from polling. This is what turns the royalty figure from an early
    warning into something filing-grade.

### The geography dependency

Turning an IP into a city or country needs a geolocation database, and the choice
matters more than it looks:

- **A local database** — MaxMind GeoLite2 or IP2Location LITE — is free, needs an
  account and a licence key, and updates monthly. Roughly 70 MB, resolved
  in-process.
- **A lookup API** is less work but **sends every listener's IP address to a third
  party**. That is the audience's personal data leaving the station's
  infrastructure for a vendor with its own retention policy.

**Use a local database.** The privacy argument decides it on its own, and it also
removes a per-lookup cost and a network dependency from the check cycle.

Note this changes the deployment: a data file that must be present in the image
or on the volume, and refreshed. The Dockerfile copies files individually — see
the trap in `HANDOFF.md` — so it must be added there deliberately.

### What collecting sessions changes about the store

Every metric above needs per-connection rows, not counts. That is a different
data shape and a much larger one: today the monitor writes one sample per channel
per minute. Sessions mean rows proportional to the **audience**, not the channel
count — at 180 concurrent listeners, potentially thousands of rows a day.

This is the point where the "SQLite is not needed yet" decision in `HANDOFF.md`
§5 expires. That note already says to revisit at ~50 mounts **or when
per-listener analytics begins, whichever comes first** — and this is that.
Decide the storage before collection starts, not after.

### 4.1 How credentials work — decided 2026-08-28

**Optional, and the tool is complete without them.** No-credentials is the
default and the common case: an affiliate pasting a stream URL has no admin
password for a server somebody else runs. Nothing on the page may depend on
having one, and nothing may break for not having one.

**Entered when a station is set up**, through the same add/edit flow as
everything else — never an environment variable, because the point is that a
station operator can supply it themselves.

**Stored against the HOST, not the station.** Icecast admin credentials are
server-wide, and five Pacifica stations share one Icecast server. Storing them
per-station would mean five copies of one secret and five places to rotate it.
This matches the existing rule that hosts are a global pool rather than a
property of a station.

**Credential-gated metrics are SHOWN, marked unavailable — never hidden.** A
missing panel teaches nobody anything; a panel reading *"Unique listeners —
unavailable for this server, needs Icecast admin access"* explains both what the
tool can do and exactly what is needed to switch it on. It also stops the page
silently changing shape depending on which station is selected.

### 4.2 Two constraints this creates

**Security — already handled, do not undo it.** `redact.publicStationConfig()`
is a strict allowlist: it builds a new object naming each field it will emit. A
credential added to a host is therefore withheld from public responses
automatically, with no change to `redact.js`. Verified against the current code
on 2026-08-28. If anyone ever converts that function to a denylist, the
credential leaks the same day.

**Privacy — not yet handled, and it needs a decision before Phase 2 ships.**
`/admin/listclients` returns **listener IP addresses and user agents**. That is
personal data about the audience, not telemetry about the station. Reading in
this app is currently public — the whole dashboard is. So either:

- everything derived from per-listener records is aggregated past the point of
  identifying anyone before it reaches any response (counts by country, counts
  by device — never a row per listener), **or**
- those panels sit behind the admin session gate.

The first is better: it keeps the page shareable, which is most of its value. But
it has to be decided deliberately, because the natural implementation — pass the
listclients rows to the client and let the chart group them — ships every
listener's IP address to anyone who loads the page.

**Phase 3 — needs new collection.**

9. Now-playing metadata retained against the audience curve, giving
   "which programme holds its audience". We already read the title every
   check and discard it.

---

## 5. What we have that they do not

Worth being clear about, because it should not get lost while chasing parity:

- **The per-mount split.** Every other panel sums the bitrate variants. Ours is
  the only view where you can see that `/live_64` carries a third of the
  audience — and it is what made the degraded-channel work possible at all.
- **Audience joined to diagnosis.** These panels report audience; this system
  reports audience *and* the root cause of every interruption to it, from the
  same record. "You lost 619 listener-minutes, here is the encoder that did it"
  is not something a stats panel can say.
- **Cross-station comparison on one host.** Five Pacifica stations share one
  Icecast server, ~28 affiliates share another. A per-station panel cannot see
  across them; we already fetch the whole inventory every 60 seconds.

---

## Sources

- [Radio Mast — Analytics](https://www.radiomast.io/docs/streaming-network/analytics.html)
- [AzuraCast documentation](https://docs.azuracast.com/)
- [Centova Cast — Statistics Report](https://centova.com/doc/cast/user_manual/02_reference_manual/06_statistics_report)
- [Icecast 2.4.1 — Admin Interface](https://icecast.org/docs/icecast-2.4.1/admin-interface.html)
- [SoundExchange — Reporting Requirements](https://www.soundexchange.com/service-provider/reporting-requirements/)
- [SoundExchange — Noncommercial Webcaster (CRB)](https://www.soundexchange.com/service-provider/non-commercial-webcaster/noncommercial-webcaster-crb/)
- [Live365 — Internet Radio Audience Measurement](https://live365.com/broadcaster/radio-audience-measurement)
- [Radio World — Making Sense of Internet Radio Ratings](https://www.radioworld.com/news-and-business/making-sense-of-internet-radio-ratings)
