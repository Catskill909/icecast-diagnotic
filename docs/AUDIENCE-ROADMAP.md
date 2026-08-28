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
3. ✅ **SHIPPED 2026-08-28. Trend against the previous period.** Withheld — null,
   not zero — unless we watched for the whole of the earlier window, because a
   monitor running four days comparing week against week reports a collapse in
   listening that only happened to the recording.
4. **Audience retained through an outage.** We hold the outage record and the
   audience curve in the same store; nobody else can join those two.
5. **Per-mount trend over time**, not just the current split — does the
   low-bitrate variant's share move?

**Phase 2 — needs admin credentials.** Deferred by decision, not blocked: see
§4.1. Build when a credential exists to build against.

6. Unique listeners, session length, TSL.
7. Geography, device and player breakdowns.
8. Real (non-estimated) ATH from per-connection data, which would make the
   royalty figure filing-grade rather than indicative.

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
