# Phase plan — the single sequencing document

> Written 2026-08-31, consolidating planning that had spread across five
> documents with four separate build orders. **This is the only place sequencing
> lives.** The detail documents keep the reasoning; they no longer keep an order.
>
> Detail lives in: [`../admin-dev.md`](../admin-dev.md) (admin panel),
> [`AUDIENCE-ROADMAP.md`](AUDIENCE-ROADMAP.md) (audience vocabulary),
> [`ADMIN-ACCESS-SCOPE.md`](ADMIN-ACCESS-SCOPE.md) (what a credential unlocks),
> [`DEEP-ANALYTICS-PLAN.md`](DEEP-ANALYTICS-PLAN.md) (the analytics build),
> [`SMS-ALERTING.md`](SMS-ALERTING.md), [`SECURITY.md`](SECURITY.md).

---

## Where the project actually is

**Live and healthy.** 5 stations, 10 channels, 3 Icecast hosts, 390 tests,
99.99% audio uptime over 7 days, data volume intact since 2026-08-04.

Build-order items 1–8 of `HANDOFF.md` §6 are shipped. Per-station alert
recipients — the item that had been "next" for four days — shipped 2026-08-31
along with the migration that retired the environment fallback.

---

## Phase 0 — close out today's work

**Entry:** now. **Exit:** nothing below is outstanding.

Not a phase of features. These are loose ends from 2026-08-31 that will be
forgotten if they are not written down.

| | Item | State |
|---|---|---|
| 0.1 | **Deploy the uncommitted docs** | ✅ Done |
| 0.3 | **The alert dispatch has not fired in production since it was rewritten** | **Unverified as of 2026-09-01.** The roundup and a test message prove SMTP and scoping; whether a real outage has since reached a station with recipients has not been checked |
| 0.4 | **Decide WPFW and KPFK recipients** | **Unverified as of 2026-09-01** — recipients are redacted from public responses, so this needs the admin panel to answer. If still empty, both stations are watched and can tell nobody |
| 0.5 | **KPFA is on the shared host and unmonitored** | ✅ Done. Live with 2 channels across two Icecast hosts (§5d) |

### Added 2026-09-01, from the rolling-windows session

| | Item | State |
|---|---|---|
| 0.6 | **Is the 7-day rise real audience, or a channel appearing?** | The week card reads **peak +79.2%, average +71.1%** against the previous 7 days. KPFT HD3 (`/classic_country`) has a `streamStart` of 2026-08-29, inside the current window and absent from the comparison window — so some of that rise may be a channel being added rather than listeners arriving. **A station-wide total that grows because the station grew is not wrong, but it must not be reported to a funder as audience growth.** Check before anyone quotes it |
| 0.7 | **`COMPARISON_COVERAGE_FLOOR` is a chosen line, not a derived one** | 0.9 — the earlier window must have ≥90% of its whole hours measured before a percentage is divided out of it. Demanding 100% withheld the week comparison over a single missed hour (24 Aug 01:00); a low floor reinstates the artefact it exists to stop. Documented at the constant in `store.js`. Revisit if real gaps cluster differently |
| 0.8 | **Reach history is 20 days shorter than level history** | Arrivals were first recorded 2026-08-24; audience levels go back to 2026-08-04. So the 30-day card reports reach as a **floor** and says so on the card. Self-resolves ~2026-09-23, when the 30-day window no longer reaches before tune-in recording |
| 0.9 | **The 30-day comparison is unavailable until ~2026-10-03** | It needs 60 days; recording began 2026-08-04. Expected, stated on the card, no action — listed so it is not re-diagnosed as a fault |

---

## Phase 1 — finish the admin panel

**Entry:** now, in parallel with anything. **Exit:** a station can be fully
configured without touching a hosting panel.

Detail: [`../admin-dev.md`](../admin-dev.md). Steps 1–6 shipped 2026-08-31
(inline recipient editing, the env migration, per-station roundups, mount chips,
add-a-channel, the timezone dropdown).

| | Item | Notes |
|---|---|---|
| 1.1 | **Mount picker from the live inventory** | The endpoint ships and is used for checking; the remaining work is offering the list as a picker rather than validating after typing. `admin-dev.md` §4.2 |
| 1.2 | **Probe Test on a mount** | Deliberately a button. A probe opens a connection Icecast counts as a listener |
| 1.3 | Icecast admin credential field, per host | Small, and it is the gate on Phase 4. `AUDIENCE-ROADMAP.md` §4.1 |

---

## Phase 2 — confidence, and the analytics that need no credential

**Entry:** any time. **Exit:** every figure on every page carries its own
provenance, and two new metrics ship.

Detail: [`DEEP-ANALYTICS-PLAN.md`](DEEP-ANALYTICS-PLAN.md) §2, §7.

| | Item | Why here |
|---|---|---|
| 2.1 | **Confidence envelope + caveat registry** | **Do this first.** Everything after renders through it; retrofitting means editing every panel twice. Today's flags — `estimated`, `floor`, `hoursMissing`, `Comparable`, `unavailable` — are four shapes meaning related things |
| 2.2 | **Programme-level audience** | The now-playing title is fetched every check and **discarded**. Storing one string per sample answers "which show holds its audience". Cheapest high-value metric in the whole plan |
| 2.3 | Day-of-week × hour heatmap | Outstanding Phase 1 item from the audience roadmap |
| 2.4 | Per-mount trend over time | Same |
| 2.5 | Migrate existing flags onto the envelope | Retires the four ad-hoc shapes |
| 2.6 | **Month-to-month by name — "October vs September"** | **Date-gated, not effort-gated. See below** |

**2.6 is the only item in this plan with a calendar entry condition.** The
audience cards became ROLLING windows on 2026-09-01 — last 24 hours / 7 days /
30 days — because calendar periods spend most of their lives partly elapsed and
produced a "This month" smaller than the week inside it. That was the right fix
for a live dashboard and it deliberately gives up something a GM needs: a named
month, for a board report, a pledge drive or a funder update.

Recording began 2026-08-04, so **August is a partial month and can never be an
honest term in a comparison.** September is the first complete month, October the
second, which puts the first truthful comparison — **October vs September — at
2026-11-01.** Build whenever; do not ship a comparison whose earlier term is
partial, because that is exactly the `+376%` artefact with a new label. Rules it
inherits are in [`AUDIENCE-ROADMAP.md`](AUDIENCE-ROADMAP.md) §4 item 6.

The data is already safe: hourly rollups are never pruned, so every past month
stays readable indefinitely. Nothing needs to be collected between now and then.

**2.1 carries a rule worth stating on its own:** a comparison inherits the
weakest confidence of its two periods. `measured` against `partial` is exactly
what produced a spurious "▼97.1%" on 2026-08-31, and the rule is what stops it
recurring in a new panel.

---

## Phase 3 — fleet view

**Entry:** after Phase 2.1, so fleet figures carry confidence from the start.
**Exit:** all stations on one screen, comparable.

Station scoping (item 5) already makes every aggregate take a station, so this is
presentation over an existing seam rather than new plumbing. It is also the
capability that makes the tool a *Pacifica-national* product rather than a
per-station one.

---

## Phase 4 — SMS alerting

**Entry:** unblocked since 2026-08-31. **Exit:** a station can be paged.

Detail: [`SMS-ALERTING.md`](SMS-ALERTING.md). ~$3–4.50/month plus a one-time
~$15–20 10DLC registration.

It waited on per-station routing, which now exists: numbers go in the same
`alerts` block as addresses, and `sendGroupedAlert()` already guarantees one
station's incident reaches only that station's people. **SMS inherits the
grouping rather than re-deriving it** — which was the entire reason for the wait.

---

## Phase 5 — Icecast admin access and deep analytics

**Entry:** a credential exists for at least one host. **Exit:** estimates have
become measurements, and every limitation is on screen.

Detail: [`ADMIN-ACCESS-SCOPE.md`](ADMIN-ACCESS-SCOPE.md) for what is unlocked;
[`DEEP-ANALYTICS-PLAN.md`](DEEP-ANALYTICS-PLAN.md) §7 for the order, which
**supersedes** the earlier order in the scope document.

**Both production hosts already answer `/admin/listclients` with 401.** The
endpoints exist and are password-protected: this phase is gated on a credential
and on nothing else Pacifica needs to build.

| | Item |
|---|---|
| 5.1 | **Read `listclients` raw** — the field shape is undocumented |
| 5.2 | **Storage and retention decision** — ~630k rows/day; this is where "SQLite not needed yet" expires |
| 5.3 | Session collection at 5-minute cadence, aggregated on arrival |
| 5.4 | **Distribution channel + ASN classification** — TuneIn and friends |
| 5.5 | Bot filtering; exclude our own probes |
| 5.6 | TSL, session distribution, player and device breakdown |
| 5.7 | Exact tune-ins; real ATH |
| 5.8 | Audience retained through an outage |
| 5.9 | Geography — in-market share, then country, then US state |

**5.2 and 5.4 are the load-bearing ones.** 5.2 because migrating a schema with a
month of rows in it is the expensive path. 5.4 because the proxied share is the
qualifier on every other audience figure — publish session-derived numbers before
knowing it and the correction lands in public afterwards.

---

## Phase 6 — affiliates at scale

**Entry:** after Phase 3 and Phase 5.2. **Exit:** ~33 stations monitored.

Five sister stations share one Icecast host **this app already fetches every 60
seconds and mostly discards**; a second host carries ~28 affiliates. Two snapshot
fetches a minute would cover all of them.

**Affiliates are more rows, not a new architecture** — but they are the reason
storage (5.2) has to be settled first, and the reason the fleet view (Phase 3)
has to exist before rather than after.

---

## Phase 7 — the public/private split

**Entry: any time; it gates nothing and unblocks Phase 5.** **Exit:** an
unauthenticated visitor sees a status page and nothing else.

**Decided 2026-08-31, and it replaces the roles idea rather than deferring it.**
The split is by **sensitivity, not by user**: one narrow public page for reading
during an emergency, everything else behind the single existing admin login.
There are no per-user accounts, no GM logins, and no permission model.

That also settles the "two panels, not one" note in `HANDOFF.md` §6 — it assumed
GM-versus-technician and therefore two kinds of login. The real division is
public-versus-private, which needs no roles at all. **The note is resolved, not
pending.**

### What the public surface is

A single page answering the question someone has at 3am: **is it up, what broke,
whose side is it, and since when.** No audience analytics, no history, no
configuration, no recipients.

### How to build it

Most of it already exists: `robots.txt` blocks every crawler, every page carries
`noindex`, and `REQUIRE_LOGIN_FOR_READ` is implemented. What it lacks is a middle
ground — today it is all-or-nothing against a hardcoded `ALWAYS_PUBLIC` set.

| | Item |
|---|---|
| 7.1 | **A purpose-built `/api/public-status`** — a narrow allowlist projection, NOT the existing rich endpoints made public |
| 7.2 | A public status page and its assets, `noindex`, added to `ALWAYS_PUBLIC` |
| 7.3 | `REQUIRE_LOGIN_FOR_READ=true` — everything else behind the login |
| 7.4 | Build out the admin section with the deeper stats (Phases 2 and 5 land here) |

**7.1 is the load-bearing decision, and today is the argument for it.** Making
the existing endpoints public would mean the public surface silently widens every
time a field is added to a stored object — which happened **three times on
2026-08-31 alone** (`/api/events`, `/api/status`, `/api/history`). A narrow
endpoint that names what it emits cannot grow by accident; a shared one can, and
did.

### The payoff beyond tidiness

**This substantially de-risks Phase 5.** `DEEP-ANALYTICS-PLAN.md` §6 offered two
defences for listener data — aggregate before serving, *or* put the panels behind
the session gate — and said the first was better because it keeps the page
shareable. **Doing both is better still.** With analytics behind the login,
aggregation becomes defence-in-depth rather than the only thing standing between
a listener's IP and the open internet.

The aggregate-only rule still stands. It is simply no longer load-bearing on its
own.

---

## Keeping every avenue open

**Decided 2026-08-31: the destination is undecided and dev must not close any
door.** Pacifica may adopt it; it may become part of a wider audio-tools
portfolio; it may be open-sourced, or licensed, or paid. **No engineering
decision should assume one of those.**

That is a real constraint, not a business note. Concretely:

### What is already safe

- **Stations, hosts and channels are data**, not code. Multi-tenancy exists.
- **Three dependencies, all permissive** (express, nodemailer, dotenv).
- **No hosting-platform lock-in** — four documented install paths.
- **Configuration lives in the store**, so a deployment is portable.

### What is currently locked, and should not be

| | Issue | State |
|---|---|---|
| **`faultSplit` used `kpft` and `pacifica` as its enum values** | Station names used as a generic vocabulary — "which side of the handoff failed". Reported **WBAI New York's outages with `side: 'kpft'`** | ✅ **Fixed 2026-08-31.** Now `source` / `server` / `unknown`. Computed on every read and never persisted, so no data migration; old names still recognised. `test/fault-side-vocabulary.test.js` |
| **Branding hardcoded in the mailer and sign-in page** | Visible to every recipient of every alert | ✅ **Fixed 2026-08-31.** One switch: `PRODUCT_NAME` / `PRODUCT_OWNER`, defaulting to the Pacifica branding. Debranding is now a config change, verified end to end |
| **No `LICENSE` file; `package.json` has no `license` field** | Undefined defaults to "all rights reserved" | ⬜ **Deliberately left.** That default is the MOST open position — a licence can be granted later, never un-granted. **The only rule: do not make the repository public without deciding first** |
| **README reads "Pacifica Foundation / KPFT Houston — Open Internal Diagnostic Tool"** | Reads as an ownership claim | ⬜ Worth a decision alongside the licence |
| `COOKIE_NAME = 'kpft_admin'`; the static salt string; file-header comments | Internal only; never seen by a user | ⬜ **Deliberately not churned.** Renaming the cookie invalidates every session for no user-visible benefit, and a salt's *content* is meaningless by construction |

### The rule going forward

**Station-specific vocabulary never becomes a wire format.** A stored enum, an
API field or a CSS class named after one customer is the thing that has to be
migrated later, and it is invisible until a second customer exists. The
`faultSplit` sides should be `source` / `server` / `unknown`, with the old values
recognised on read — exactly the pattern already used for the retired `blip`
severity.

### Licence and hosting are separate questions

Worth stating because they were conflated once already:

- **Hosting** — if Pacifica reaches a URL we run, no code changes hands and the
  licence barely matters.
- **Distribution** — the moment a repository, image or tarball leaves our
  machines, the licence governs what the recipient may do.

**No LICENSE file today means all rights reserved**, which is the most open
position available and requires no action. Grant one when the destination is
known.

### One decision that interacts with the business model

**The geo database choice (Phase 5.9) is a licensing decision as much as a
technical one.** If the product is ever distributed rather than hosted for one
customer:

- **MaxMind GeoLite2** — its EULA restricts redistributing the database. Each
  deployer obtaining their own key is fine; bundling it may not be.
- **IP2Location LITE (CC BY-SA)** — share-alike, which some commercial models
  dislike.
- **DB-IP Lite (CC BY)** — cleanest for redistribution, weakest at city level.

**Do not treat this as settled until the distribution model is.** Requiring each
deployer to supply their own key sidesteps it entirely and is the option that
closes no doors.

---

## Decisions already made, so they are not re-litigated

| Decision | Where |
|---|---|
| Recipients live in the store; env only seeds, once | `HANDOFF.md` §5c |
| One list per station — no CC | `admin-dev.md` §6.1 |
| One weekly roundup per station, in its own timezone | `admin-dev.md` §6.2 |
| No address verification; a Test button instead | `admin-dev.md` §6.3 |
| Alerts screen lives in the admin panel until roles exist | `HANDOFF.md` §5c |
| Geography: MaxMind GeoLite2 City; US state/metro, country elsewhere | `ADMIN-ACCESS-SCOPE.md` §2 |
| Local geo database, never a lookup API | `AUDIENCE-ROADMAP.md` §4 |
| Aggregate before it leaves the server; no per-listener row in any response | `DEEP-ANALYTICS-PLAN.md` §6 |
| Individual device or person identity is a **non-goal** | `DEEP-ANALYTICS-PLAN.md` §1 |
| Icecast control endpoints (`killsource` etc.) out of scope | `ADMIN-ACCESS-SCOPE.md` §3.4 |

---

## Open questions

**Resolved 2026-08-31: Pacifica is asking for the software, and access and
permissions are not obstacles.** That settles four of the five questions this
section used to hold. Phase 5 needs a credential requested rather than
negotiated, and Phase 6 becomes engineering rather than politics.

| Was | Now |
|---|---|
| Will Pacifica issue an admin credential? | **Not a blocker.** Phase 5 needs the credential requested, not negotiated |
| Does a shared-server credential entitle us to read unmonitored stations? | **Not an obstacle.** Still worth deciding what we *choose* to read — restraint is a design position, not only a permission one |
| Do Pacifica national have authority to monitor affiliates? | **Not a blocker.** Phase 6 is engineering, not politics |
| Is the customer Pacifica, or a product with Pacifica as first user? | **Pacifica is the customer**, and asking |

**Two remain, and neither blocks anything.**

1. **Does Pacifica host this, or do we run it for them?** No longer a question
   about roles — the public/private split (Phase 7) is the same either way. It
   affects the handover: who holds the credentials, and whether the deployment
   has to survive without us. `docs/INSTALL.md` already covers four hosting
   paths, so this is documentation rather than architecture.

2. **Is there an existing listener-privacy policy?** If Pacifica has published
   one it decides `DEEP-ANALYTICS-PLAN.md` §6 rather than us. Not a blocker —
   the aggregate-only design plus the Phase 7 login gate complies with any
   reasonable policy — but worth asking before Phase 5.9 rather than after.

**Explicitly NOT a question any more: per-user roles and multi-user accounts.**
One shared admin credential, plus a narrow public page. Anything more is not
planned.
