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

**Live and healthy.** 5 stations, 10 channels, 3 Icecast hosts, **823 tests**,
99.63% audio uptime over 7 days, data volume intact since 2026-08-04.
(Station/uptime figures re-verified against production 2026-09-02; test count
2026-09-11.)

**`AUDIENCE-ROADMAP.md` §4.5 is complete as of 2026-09-11** — returning vs new
listeners, device mix over time, dayparts by region, metro-level geography and
session length. Four of the five needed no new collection at all.

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
| 0.10 | **Backup is a HOST responsibility, and it does not travel with the app** | The application copies its data nowhere — nothing in `store.js`, `monitor.js`, `server.js` or `scripts/` backs anything up, and writes being atomic (temp + rename) protects against a torn write, not against a lost volume. **On the current Coolify VPS this is already solved at the infrastructure layer: the operator has host snapshots and daily backups** (confirmed 2026-09-01), which is the normal and correct place to solve it. Two things follow. **(a)** Confirm the daily backup actually includes the named volume `icecast-monitor-data`, not only the host image — Coolify's scheduled-backup feature is database-oriented and a volume can sit outside it. **(b) The arrangement is a property of THIS host and does not move with the app.** Re-establish it on the Pacifica server before cutover, because two things there have no other source: `events.json` (the permanent incident record since 2026-08-04) and the hourly rollups in `samples.json` (the ONLY long-term audience history — once raw samples compact, the rollup is the sole copy and re-polling Icecast cannot recover a single past hour) |

### Storage: measured 2026-09-01, not projected from assumptions

Live figures: `events.json` **1.15 MB** / 483 events (cap 100,000, FIFO);
`samples.json` **12.65 MB** / 58,263 raw samples + 1,518 rollups. Measured unit
costs: **207 bytes per sample, 204 bytes per rollup, ~2.4 KB per event.**

| Store | Bounded? | Steady state / growth |
|---|---|---|
| Raw samples | **Yes** — `SAMPLE_RETENTION_DAYS` (7) | ~2 MB per channel, flat for ever |
| Hourly rollups | **No** — kept for ever, by design | ~1.7 MB per channel per year |
| Events | **Yes** — newest `MAX_EVENTS` (100,000) | ~238 MB absolute ceiling |

Ten years at today's 10 channels ≈ **240 MB**. Ten years at 33 stations
(~100 channels) ≈ **2.1 GB**. **Disk is not the constraint and will not become
one.**

**The eventual constraint is write amplification rather than capacity — and it is
NOT a defect, NOT urgent, and needs no action now.** `store.save()` rewrites the
whole of `samples.json` every `SAVE_INTERVAL_MS` (60 s), guarded by a dirty flag
that is set every cycle in practice, and the whole store is held in memory.

Measured serialisation cost: **2.4 ms per MB.**

| Scale | `samples.json` | Pause per minute | Duty cycle |
|---|---|---|---|
| Today, 10 channels | 12.65 MB | ~30 ms | **0.05%** |
| ~50 channels | ~100 MB | ~240 ms | 0.4% |
| ~100 channels | ~200 MB | ~480 ms | 0.8% |

Even the last row is under 1% of wall-clock, so this degrades gently and never
falls over. **Do not pre-emptively rebuild storage for it.** The trigger already
recorded stands: revisit SQLite **at ~50 mounts, or when per-listener analytics
begins, whichever comes first** — at which point memory footprint and startup
parse time matter more than the write itself. Acting earlier means building the
storage layer twice.

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

**ENTRY CONDITION MET 2026-09-02.** Pacifica issued an admin credential for
`streams.pacifica.org:9000` — the host carrying all five sister stations. This
phase is no longer waiting on anyone. `streaming.wbai.org` is a separate server
with no credential, so WBAI stays on credential-free figures.

**Start at 5.1 and do not skip to 5.3.** Two things gate collection, both named
below: the field shape is undocumented (5.1 — now done, see
`ADMIN-ACCESS-SCOPE.md` §0.3), and the storage decision (5.2) has to be made
before rows exist rather than migrated after.

**Nothing is gated on Pacifica.** The credential covers the whole shared host and
that is authorised (`ADMIN-ACCESS-SCOPE.md` §8). Only the ordinary build rule in
§5 remains: the dashboard needs no login to read, so aggregate per-listener data
server-side rather than shipping rows to the page.

| | Item |
|---|---|
| 5.1 | **Read `listclients` raw** — the field shape is undocumented |
| 5.2 | **Storage and retention decision** — ~630k rows/day; this is where "SQLite not needed yet" expires |
| 5.3 | Session collection at 5-minute cadence, aggregated on arrival |
| 5.4 | **Distribution channel + ASN classification** — TuneIn and friends. **DONE 2026-09-02** (`geo.js`, `listener-detail.js`) |
| 5.5 | Bot filtering; exclude our own probes |
| 5.6 | TSL, session distribution, player and device breakdown |
| 5.7 | Exact tune-ins; real ATH |
| 5.8 | Audience retained through an outage |
| 5.9 | Geography — in-market share, then country, then US state. **DONE 2026-09-02** — needs `MAXMIND_LICENSE_KEY`; DB-IP City cannot do states, see `HANDOFF.md` §5j |

**5.4 landed after the session figures it was supposed to precede.** The build
order says the proxied share must ship *before* anything derived from sessions,
so that the correction does not land publicly afterwards. TSL, session
distribution and the player mix went out first, and the qualifier followed on
2026-09-02. It is now rendered at the top of the section it qualifies rather
than as one tile among six.

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

## Access tiers — decided 2026-09-11, and why env vars are the path

**One login for all, and it stays that way until the move to Pacifica
production.** This confirms Phase 7 below rather than competing with it: the
split is by SENSITIVITY, not by user. The figures that matter in an emergency —
is it up, what broke, whose side is it, since when, and the alerts — are exactly
the ones that need no credential of any kind. Analytics sit behind the one admin
login. No roles are required for that to be correct.

**Icecast admin credentials go in the hosting panel's environment**
(`ICECAST_ADMIN_CREDS`, a per-host JSON map), shipped 2026-09-11. This is the
tier-friendly choice, and the reason is worth stating because it is easy to get
backwards:

> **An Icecast admin password is a property of a SERVER, not of a person.** It
> never belongs to a role. Whatever access model arrives later governs *who may
> see the panel*, not *who holds the password* — so putting credentials in the
> environment today costs nothing later and needs no migration when roles exist.

The opposite choice — building per-host credential entry into the admin panel
now — would bind a secret to a UI whose permission model is undecided, and would
have to be rebuilt the moment it is decided. `AUDIENCE-ROADMAP.md` §4.1
specifies that entry flow and it remains the destination; it is sequenced after
the access decision, not before it.

**What is deliberately NOT decided yet**, and should be settled at the Pacifica
move when the real users are known:

| Question | Why it waits |
|---|---|
| Per-user accounts, or one shared login | Depends on how many people at how many stations actually sign in, which nobody knows yet |
| Whether a GM sees a different surface from an engineer | Phase 7 says this is public-vs-private, not GM-vs-technician. Revisit only if real use contradicts it |
| Who may enter or rotate an Icecast credential | Meaningless until there is more than one kind of account |
| Whether a station sees only its own data | Today every signed-in reader sees every station. On a network of independent licensees this is a governance question, not a technical one |

**The migration path, if tiers do arrive.** Nothing shipped needs undoing:
credentials stay in the environment; the existing session gate becomes one of
several; `redact.js` is already an allowlist, so a narrower view is a new
projection rather than a rewrite; and the `auth` capability flags in
`/api/config` already report configuration without exposing it.

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

## Phase 8 — export and import, for moving the deployment

**Entry: any time; it gates nothing and it unblocks the move to Pacifica.**
**Exit:** a deployment can be reproduced on a different host from one file, and
the figures on the new host are continuous with the old.

**Why it is worth doing before it is needed.** There is no backup today. The
README already says the volume must be persistent or every redeploy resets the
record to zero — an export endpoint IS the backup, and the first phase below is
useful on its own even if the move never happens.

### What is actually on the volume

| File | Holds |
|---|---|
| `events.json` | the event record, the **station/channel/host configuration**, and the meta store |
| `samples.json` | rolling telemetry — 7 days raw, then hourly rollups kept indefinitely |
| `devices.db` | SQLite: device records (cume, places, sessions) and `region_hours` |
| `history.json` | legacy, migrated on load |

Meta keys worth naming because they are operational state, not derivable:
`deviceSalt`, `storms`, `compactCarry`, `lastWeeklyRoundup`,
`lastWeeklyRoundupDay`, and four one-shot migration markers
(`alertRecipientsSeeded`, `jsonImported`, `mountCollisionRepaired`,
`tuneInsRepaired`).

### THE ONE THAT WOULD RUIN THE MIGRATION SILENTLY

**`deviceSalt` and `devices.db` are ONE ARTEFACT and must never travel apart.**

A device is a salted hash of IP and user agent. The salt lives in
`events.json`; the hashes live in `devices.db`. Copy the database without the
salt and every returning listener hashes to a new value: cume jumps by the whole
audience on day one, and **"came back" reads zero for ever** because no device
on the new host matches any device on the old.

`store.js` already carries this warning for an unclean restart — *"Nothing
errors and nothing looks wrong; the graph just goes up."* A migration is the
same failure, permanent, and on the figures a station would notice last.

So the export is a **bundle, not a set of files**, and the import refuses a
bundle whose salt is missing.

### The second hazard: a bundle is a file, and files get emailed

`host.statusUrl` may carry credentials — `https://user:pass@host/admin/stats.xml`
— which is why `redact.js` withholds it from public responses. An export is
worse than an API response: it gets downloaded, forwarded, and left in a
Downloads folder. **The export must strip credentials from every URL it emits
and say in the manifest that it did**, so the operator knows to re-enter them
rather than wondering why discovery fails.

### The third: SQLite is not a file you can copy while it is running

The database runs in WAL mode, so recent commits live in `devices.db-wal` and a
plain copy is torn. `VACUUM INTO` produces a consistent single-file snapshot
without stopping the app, and is the only correct way to take it.

### What is deliberately NOT in the bundle

Every secret: SMTP, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, and
`ICECAST_ADMIN_CREDS`. None of them is on the volume — they are environment, by
design. **So a bundle can never reproduce a deployment on its own**, and
pretending otherwise is how a migration ends with a running app that mails
nobody. The manifest therefore carries a **checklist of the environment
variables the new host needs, by NAME and never by value**, generated from what
this instance actually has configured.

### Format

One gzipped JSON file — `icecast-monitor-<host>-<date>.json.gz`.

| Decision | Why |
|---|---|
| **Single file** | A migration is carried by a person. Four files is three chances to move three of them |
| **JSON, gzipped with `zlib`** | Node built-in; this project has three dependencies and should keep it that way. `tar` would mean a fourth or a hand-written writer |
| **`devices.db` base64 inside it** | Binary in a text bundle costs ~33% before compression and gzip takes most of it back. Worth it for one inspectable artefact |
| **A `manifest` first** | `gunzip -c bundle.json.gz \| jq .manifest` must answer "what is this, from where, from when, how much" without parsing megabytes |

The manifest carries: app version, bundle schema version, source host, created-at,
counts (stations, channels, events, samples, devices), byte sizes, a SHA-256 per
part, the env-var checklist, and whether any URL was redacted.

### Phasing, smallest useful thing first

| | Scope | Why this order |
|---|---|---|
| **8a** | **Export only.** `GET /api/export` (authenticated), streamed, plus `scripts/export.js` for a shell | It is the backup. Useful the day it ships, with no import risk, and it can be verified by inspecting the file |
| **8b** | **Import into an EMPTY volume.** `POST /api/import`, refuses if any data exists | The migration case. Replace-only semantics: merging two event logs and two device databases is a correctness problem nobody needs |
| **8c** | **Import OVER an existing volume**, with the old data renamed aside rather than deleted, and an explicit confirmation | Only if 8b proves insufficient. Rollback matters more than convenience here |

### Rules the import must follow

- **Refuse a bundle from a NEWER app version.** Schema moves forward; an old
  binary reading a new bundle is the one failure that corrupts rather than stops.
- **Verify every checksum before writing anything.** A truncated download must
  fail loudly, not half-import.
- **Replace, never merge.** Two event logs cannot be interleaved without
  duplicate ids, and two device databases cannot be unioned across different
  salts at all.
- **Write to a temporary directory, then swap.** A crash mid-import must leave
  the previous volume intact.
- **Require a restart afterwards**, and say so in the response: configuration,
  streams, storm state and the salt are all held in memory after `load()`.
- **Report what was NOT restored** — the env checklist — in the same response,
  so the operator sees it at the moment they need it.

### Acceptance, stated as a test rather than a feeling

> Export from the live deployment, import into a clean container with only the
> environment variables the manifest listed, restart, and: the station list is
> identical, the oldest event predates the move, uptime for last month is the
> same figure to two decimal places, and **"came back" is non-zero on the first
> read** — which is the one that proves the salt travelled.

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


## Audience filter bug fix — 2026-09-10

Status: **In progress** — implementation and targeted regression tests complete;
manual deployment and signed-in browser acceptance remain open.

- [x] Changing station or range requests both audience APIs for the selection.
- [x] Player/App and platform figures update without a page reload.
- [x] Live totals, sessions, mounts, distribution and geography use the same
  station scope, keyed by host plus path; All stations remains supported.
- [x] Previous figures clear during loading, including listening hours; late
  fetch/JSON results and failures cannot overwrite a newer selection.
- [x] Historical device totals remain available without current listeners.
- [x] Six targeted behavioral tests and JS syntax checks pass. Full suite now passes 656/656 after freezing the two historical fixture
  clocks (2026-09-10); evidence is in HANDOFF.md and docs/DEVLOG.md.
- [ ] Deploy through the existing manual Coolify release flow and verify in a
  signed-in browser: KPFK → All stations → another station, range changes, rapid
  changes, and absence of stale Player/App or per-mount values.

Exit criteria: all checks above pass, with deployment and browser evidence
recorded. A scoped multi-mount distinct-address union remains unavailable because
it is not stored; the page explicitly says so.


## CI fixture clock repair — 2026-09-10

Status: **Complete** — all local exit criteria verified on 2026-09-10.

- [x] Freeze the historical fixtures before store.load() applies retention.
- [x] Keep all original assertions and production retention/repair logic intact.
- [x] Both affected test files pass 12/12; the full suite passes 656/656 with
  no failures or skips on Node 24.20.0. Diff whitespace check passes.

Release remains pending: push the correction and confirm GitHub CI is green
before the owner deploys through Coolify. Audience browser acceptance remains
open in the preceding section.


### Audience deployment follow-up — 2026-09-10

Status: **In progress** — owner reports live deployment but signed-in acceptance
remains unresolved. Live JS matches HEAD f81a407; fresh Chromium sends both
station-scoped requests. Full protected-panel dropdown/reload equivalence passes
with synthetic API responses; real signed-in detail values have not been tested.
See the latest HANDOFF.md entry for evidence and the next diagnostic action.


## History selection consistency — 2026-09-10

Status: **In progress** — race reproduced and fixed locally; live release
acceptance remains open.

- [x] All stations and all five individual stations remain selectable.
- [x] Five History endpoints capture one station/range per refresh, with atomic
  rendering and protection against old responses, JSON bodies and errors.
- [x] Previous numbers are hidden while loading/failed; controls remain usable;
  export is disabled until current data loads; Retry recovers a failed refresh.
- [x] Six regression tests pass; full suite 662/662, no skips/failures.
- [x] Chromium verifies all six choices against real public APIs with patched
  assets, plus the delayed-response reproduction, range change and error/retry.
- [ ] Push, confirm green CI, deploy through Coolify and verify live selections
  after loading the new script once. Record evidence before closing this phase.

Broader audit remains In progress. Protected Audience API/UI checks have not
been completed in a verified authenticated browser session.

---

## Audience analytics build-out — 2026-09-11

`AUDIENCE-ROADMAP.md` §4.5 closed in one session. Recorded here because the
*hazards* it surfaced outlive the features, and anything computed over the
device record later will meet them again.

**Shipped:** returning vs new listeners · device and player mix over time ·
when each region listens (dayparts) · metro-level geography · session length.
Plus per-host Icecast credentials, a coverage band naming which channels the
credentialed figures actually cover, and two sign-in fixes.

**Four hazards, each of which produced a plausible wrong number before it was
caught.** The data is sampled, tiered and folded, and each of those does
something different to a figure computed naively over it:

| Hazard | What it produced | The rule |
|---|---|---|
| **Tiers smear a boundary** | `returning` went 1 → 2 on identical data purely because compaction ran — loyalty manufactured by a maintenance job | Snap windows to the tier, or refuse. Re-bucket where a coarser answer is still honest |
| **Detail is lost at compaction** | An hour-of-day profile is impossible 48 hours after the fact | Pre-aggregate the cross-tab BEFORE the detail goes. It cannot be backfilled |
| **Repeated sampling is length-biased** | A six-hour session appears in ~72 readings, a two-minute one in at most one | Store per device and reduce; never tally per reading and sum |
| **A gate sized for one claim is wrong for a smaller one** | 200 km is inside one state and spans several cities | Tighten the gate with the claim; degrade to the coarser answer rather than refusing |

**A correctness bug found on the way**, unrelated to the new features: KPFA is
carried on two servers and only one is credentialed, so its individual-listener,
geography and daypart figures covered half the station and were presented as the
whole. `detailCoverage` now reports which channels are covered, per channel,
with the host named.

**Measured cost**, 108,000 device rows over 90 days, uncompacted (the worst
case; production keeps most of it pre-aggregated): distinct devices 76 ms,
returning 29 ms, device trend 77 ms, region-hour profile 181 ms. About 0.4 s for
the full 90-day signed-in view.

**A boundary was deliberately moved.** `test/geo.test.js` asserted "no city name
survives a lookup", correct while city was out of scope. It is now seven tests
describing a narrower rule. **The coordinate boundary did not move and must not:**
no latitude or longitude survives a lookup, so a dot-per-listener map stays
impossible to build downstream by accident.

