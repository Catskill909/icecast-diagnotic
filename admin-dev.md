# Admin panel — design plan

> Written 2026-08-31 after the first per-station alert UI shipped and was found
> confusing in use. This is a plan, not a changelog: it states the problems, the
> reasoning, the options rejected, and the order to build in.
>
> Companion to [`HANDOFF.md`](HANDOFF.md) §5c and
> [`icecast-app-future-dev.md`](icecast-app-future-dev.md) §5.

---

## 1. What is actually wrong

Three problems, confirmed in the code rather than inferred from the screenshot.

### 1.1 Two panels open at once — a bug

`openEditor()` and `openAlerts()` each toggle their own container and neither
closes the other, so clicking Edit and then Alerts leaves a station card showing
two stacked forms with two Save buttons. Which one saves what is not stated
anywhere on screen.

**Severity: low, fix: trivial.** No design decision needed — opening one panel
closes the other. Listed here only so the count is honest.

### 1.2 The recipient list on screen is not the list that gets emailed — a design flaw

This is the real problem, and it is architectural rather than cosmetic.

KPFT's alerts today go to `gm@kpft.org` and `omaclay@gmail.com`, copying
`paul@hype.net`. Those addresses live in environment variables. The panel reads
only the station's stored `alerts` block, which is empty. So the screen shows:

```
  Alerts are on
  2 recipients, copying 1. Using the monitor-wide list — none of its own.

  Alert recipients
  None set — this station falls back to the monitor-wide list.
```

**A banner saying "2 recipients" directly above a list saying "none".** Both
statements are true and the combination is nonsense to read. The two addresses
that actually receive KPFT's outage alerts cannot be seen, cannot be edited,
cannot be corrected for a typo, and cannot be removed — from the screen whose
entire purpose is managing who gets alerted.

**The root cause is two sources of truth.** `ALERT_EMAILS` is a permanent
runtime fallback, consulted on every send, invisible to the UI. That contradicts
a rule this project already settled — from README, *Where configuration lives*:

> Station, channel and host configuration lives in the data store, not in
> environment variables. On the first boot against an empty volume, `STREAMS`
> seeds it; from then on the store is authoritative and env changes are ignored.
> **This is deliberate. An admin panel changes settings while the app is
> running, so the store has to win.**

Alert recipients are configuration an admin panel changes while the app is
running. They were built as an env fallback anyway. Every symptom above follows
from that one inconsistency, so the fix belongs there and not in the widget.

### 1.3 Mounts can be dropped but not added — an incomplete feature

The channel editor renders mounts as one space-separated text field
(`/live_128 /live_64`) and splits it on whitespace when saving. Three problems:

| | |
|---|---|
| **No add affordance** | Technically you can type another path into the field. Nothing says so, and a text field holding a space-separated list is not a control anyone reads as "a list you may extend" |
| **No validation that the mount exists** | The only check is that it starts with `/`. A typo saves cleanly and produces a channel that silently under-reports its audience, or a degraded-mount alert for a mount that never existed |
| **`Drop` removes a CHANNEL, not a mount** | The button sits at the end of a channel row. Nothing removes a single mount except editing the text |

Adding a channel is missing entirely: the editor can only drop them.

---

## 2. What standard alerting tools do

Worth naming, because the current design is unusual and it is fair to ask why.

| Tool | Model |
|---|---|
| UptimeRobot, Better Uptime, Pingdom | **Alert contacts** defined once, then assigned per monitor |
| PagerDuty | Users → escalation policies → services |
| Grafana | Contact points → notification policies |

The common shape is **two levels: define people once, assign them per thing
being watched.** Ours has one level with a hidden second one bolted underneath.

Three conventions we do not follow, and should:

1. **Every address shown is editable.** Not "delete and retype" — correcting a
   typo should not require destroying the row.
2. **No list is displayed that the screen cannot change.** If a value is
   inherited, either make it adoptable or do not show it as though it were
   editable.
3. **A new address is verified before it is trusted.** Full double opt-in is
   more machinery than four stations justify. **A "send test" button is the
   pragmatic substitute** and we already have the endpoint.

---

## 3. Proposed model for recipients

**Every station owns an explicit, editable recipient list. There is no invisible
fallback at send time.**

`ALERT_EMAILS` becomes what `STREAMS` already is: a **seed**, read once on first
boot against an empty volume, then never consulted again.

| | Today | Proposed |
|---|---|---|
| Source of truth | env, with per-station override | the store, always |
| Shown in the panel | only the override | the actual list |
| Editable | only the override | always |
| `ALERT_EMAILS` | consulted on every send | seeds an empty store once |

### 3.1 Options considered

**Option A — show inherited addresses as read-only rows with an "Use a list for
this station" button that copies them in.**
Keeps the fallback. Honest, and a smaller change. Rejected as the primary fix:
it preserves two sources of truth, so every future feature (SMS numbers,
per-station quiet hours, escalation) inherits the same split, and the panel
keeps a mode where what you see is not what you may change.

**Option B — migrate `ALERT_EMAILS` into each station's stored list at boot.**
One source of truth, everything editable, the panel becomes ordinary. Costs a
migration that must not change who currently receives email. **Recommended.**

**Option C — global "contacts" plus per-station assignment**, the UptimeRobot
model. Correct at fifty stations. At four it adds a second screen and an
indirection to manage three addresses. Revisit with the fleet view.

### 3.2 The migration is the risky part

Seeding must not change who gets email — the entire value of the change is
undone if it pages someone new.

`ALERT_STATIONS=kpft` today, so **only KPFT may email**. A naive migration that
copies `ALERT_EMAILS` onto every station would sign KPFT's staff up for WPFW,
KPFK and WBAI — the exact 3am failure this whole feature exists to prevent.

Rules the migration must follow:

1. Seed a station's list **only if that station is currently permitted to email**
   — that is, `ALERT_STATIONS` is empty or names it.
2. Every other station is seeded **explicitly empty and disabled**, which is
   what it effectively is today. Recorded as a decision, not left blank.
3. `ALERT_CC` is **merged into that same one list**, deduplicated — not seeded
   as a separate `cc` (see §6.1). It has a real member today, `paul@hype.net`,
   and dropping it on the way through would silently stop the monitor owner
   receiving anything.
4. Run **once**, against a store with no `alerts` blocks, and record a marker in
   `meta` so a redeploy cannot re-run it over an operator's later edits.
5. **Write a test that asserts the recipient set before and after the migration
   is identical, per station**, for the current production configuration. That
   is the only check that actually answers "did this change who gets paged".

Until it runs, the env fallback stays in place, so a half-deployed state still
sends correctly.

### 3.3 What the panel then shows

With one source of truth, the screen becomes conventional:

```
Alert recipients                                    ← always the real list
Emailed when KPFT Houston goes off air and again when it recovers.

  gm@kpft.org                          Edit   Test   Remove
  omaclay@gmail.com                    Edit   Test   Remove
  paul@hype.net                        Edit   Test   Remove

  [ name@station.org              ]  [ Add ]
  One address, or several separated by commas.

☑ Send alerts for this station
```

- **Edit** turns the row into an input in place. No delete-and-retype.
- **Test** sends one message to that address alone — the substitute for
  verification, and the only way to find out an address is wrong before an
  outage does it for you.
- The banner stops being needed to explain where the list came from. It keeps
  one job: whether mail will actually go out, and what is blocking it if not.

---

## 4. Proposed model for mounts and channels

### 4.1 Mounts become a list, not a text field

Chips with an × each, and an add control — the same shape as recipients, because
it is the same interaction. Never a space-separated string.

### 4.2 Offer what the server actually publishes

We already fetch every host's full inventory once a cycle, and
`/api/stations/discover` already turns a URL into a grouped mount list. So the
add control should **offer the mounts the Icecast host is really serving**, as
a picker, with free text kept only as a fallback for a mount that exists but is
not currently listed.

**Picking from a list of real mounts eliminates the typo class entirely**, which
is better than validating it after the fact.

### 4.3 "Test before adding" — and what it costs

Two levels of check, and they are not equivalent:

| Check | Proves | Cost |
|---|---|---|
| Present in the host's `/status-json.xsl` inventory | Icecast lists this mount | free — already fetched |
| Probe it | Icecast will actually serve audio on it | **opens a connection** |

**The probe is not free, and this is the trap that must not be re-learned.**
Icecast counts every connection as a listener, ours included — measured: one
connection took `/kpfk` from 1 listener to 2. It is why the snapshot is fetched
before probes and why non-primary mounts are probed only every
`VARIANT_PROBE_EVERY` cycles.

Therefore:

- Inventory presence is checked **automatically** — free, and catches the typo.
- A probe happens **only when the operator presses Test**, never on keystroke,
  blur, or save. The button says what it does.
- The result is shown against the mount: listed / serving / not found.

### 4.4 Adding a channel

Missing entirely. Same picker: choose one or more mounts the host publishes,
name the channel, and the id is generated and then immutable — **the editor must
continue to offer no way to type an id**, because renaming one orphans its
history rather than moving it.

---

## 5. Build order

> Where this sits among everything else: **Phase 1** of
> [`docs/PHASE-PLAN.md`](docs/PHASE-PLAN.md).

Smallest first, and each step is independently shippable.

| | Change | Status |
|---|---|---|
| 1 | Opening one panel closes the other | ✅ 2026-08-31 |
| 2 | Edit and Test on each recipient row | ✅ 2026-08-31 — inline edit, Enter saves, Escape abandons; Test sends to that one address and nobody else |
| 3 | **Seed `ALERT_EMAILS` into the store, retire the send-time fallback** | ✅ 2026-08-31 — `seedAlertsFromEnv()`, marker-guarded. `test/alert-migration.test.js` asserts the before/after recipient set is identical per station |
| 4 | **One weekly roundup per station** (§6.2) | ✅ 2026-08-31 — own list, own scope, own timezone, own weekly marker and retry counter |
| 5 | Mounts as chips with add/remove | ✅ 2026-08-31 — each mount is a chip with an ×, plus its own add field. A pasted full URL is reduced to its path |
| 6 | Add a channel | ✅ 2026-08-31 — **+ Add a channel** in the editor; the id is generated from the name and shown before saving, never typed |
| 7 | Mount picker from the live inventory + probe Test | ⬅ **NEXT.** §4.2–4.3 |

Steps 1–4 shipped 2026-08-31. Steps 3 and 4 changed who receives email, so both
had their tests written before the code; step 3 was additionally verified against
a running instance — seeded, cleared by hand, restarted, and confirmed still
cleared, because the migration re-running over an operator's edit is the one
failure the unit tests could not have caught on their own.

Steps 5–6 touch no email at all. Step 7 is what removes the typo class outright
rather than validating after the fact, and it is the one with the listener-count
cost attached (§4.3) — a probe opens a connection Icecast counts as a listener,
so it must be a button someone presses, never a keystroke or a save.

---

## 6. Decisions (settled 2026-08-31)

### 6.1 `ALERT_CC` is retired entirely

**One list. An address is an address.**

CC exists in human email to separate "act on this" from "for your awareness". In
an automated alert it separates nothing: identical message, identical delivery,
anyone can act on it. It survived here only because an env var of that name
existed, and it has caused a disproportionate share of the confusion in this
feature — a second field in the UI, a second list in the roundup that was read
inconsistently and cost the monitor owner seven weeks of reports, and a second
concept in every explanation.

After migration there is no CC anywhere: no env var consulted at send time, no
field in the panel, no `cc` on the mail. Every recipient goes in `To`.

**What this means for the migration.** KPFT's seeded list is
`ALERT_EMAILS` + `ALERT_CC` merged and deduplicated — today
`gm@kpft.org`, `omaclay@gmail.com`, `paul@hype.net`. Three addresses, one list,
and exactly the same three people receiving exactly what they receive now.

The `cc` field stays *accepted* by the store and the API for one release so a
stored value is never silently destroyed, and the delivery record keeps its `cc`
so historical events still render truthfully. Neither is offered in the UI, and
nothing new writes to them.

> The roundup's `ALERT_CC` fix made earlier today stays correct and stays
> necessary **until** this migration runs — at which point it becomes moot,
> because there will be one list and the roundup will read it. It is a stopgap
> that is doing real work in the meantime.

### 6.2 The weekly roundup becomes one report per station

Confirmed. Today it is one monitor-wide report, scoped to a single station only
when `ALERT_STATIONS` happens to name exactly one — so a station configured in
the panel gets its outage alerts and never its own weekly report.

Each station gets its own roundup, scoped to its own channels, addressed to its
own list. The rules that follow from that:

| | |
|---|---|
| A station with no recipients | gets no roundup. Not an error — nobody to send to |
| A station with alerts switched off | gets no roundup. Switching alerts off means "do not email this station's people", and a weekly report is email |
| Send time | each station's own `WEEKLY_ROUNDUP_HOUR` in **its own timezone** — WPFW is Eastern, KPFK Pacific. A 9am report should arrive at 9am where the reader is |
| The once-per-week guard | becomes **per station**, keyed by station id and that station's local date. Today it is one `lastWeeklyRoundupDay` marker; one station failing to send must not mark the week done for the others |
| Failure and retry | per station, for the same reason |

**This is a different shape, not a parameter.** `sendWeeklyRoundup()` currently
builds one rollup and one message; it becomes a loop over stations, each with its
own scope, recipients, timezone, marker and retry state. `WEEKLY_ROUNDUP_EMAILS`
retires along with the global list.

### 6.3 No address verification — a Test button instead

Rejected: double opt-in, where a newly added address receives nothing until
someone clicks a confirmation link in it.

It guards against adding someone who does not want mail, which is not the
problem here — these are named station staff. And it fails in the worst
available way for this system: an address added and never confirmed **silently
receives nothing**, which is precisely the class of quiet failure this project
exists to eliminate.

**Test** delivers the actual benefit — proving an address works before an outage
tests it for you — with no silent state. It is the only verification we build.

---

## 7. What the model reduces to

After the decisions above, the whole feature is one sentence:

> **Each station has a list of email addresses, and a switch. Everything that
> station sends goes to that list.**

No fallback, no CC, no second list for the weekly report, no verification state,
no monitor-wide anything. Env variables seed it once on first boot and are never
read again.

That is the version worth building. Each thing removed here was a concept
somebody had to hold in their head to answer "who gets told when this breaks".

---

## 8. What "Could not save." taught us

An operator hit a save failure on the alert panel and reported the entire
message: **"Could not save."** That was the whole diagnostic surface for four
different failure modes — a rejected address, an exception in the route, a
dropped connection, a proxy error — and it was not reproducible from either end.

Three things were wrong, and all three are now fixed:

| | |
|---|---|
| The route could throw and return express's **HTML** error page | The panel parsed it as JSON, got nothing, and fell through to its generic message. The route now returns JSON on every path and logs the exception server-side |
| `api()` discarded a non-JSON body | `res.json().catch(() => ({}))` threw the evidence away. It now keeps the raw text |
| Every failure rendered the same six words | `failureText()` distinguishes a validation error, a server error with its message, an unreachable server, and a bare status code |

**It was not reproduced.** Tried against a copy of the production configuration,
as a deployed instance with SMTP configured, and with a production-sized store
(a 3.7 MB samples file, on the theory that a forced write behind a proxy was
timing out — it took 14 ms). Every attempt returned HTTP 200. Recorded here as
unexplained rather than quietly assumed fixed: the change guarantees the *next*
occurrence names itself, which is not the same as knowing what happened.
