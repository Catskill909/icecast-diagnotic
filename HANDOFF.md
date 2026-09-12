# Handoff — Icecast Monitor

> **START HERE.** Everything below this section is a dated log, newest first.
> This part is the current state and is rewritten rather than appended to.

> ### ⚠️ OPERATING RULES — read before diagnosing anything
>
> 1. **The monitor is in DEVELOPMENT.** Only **KPFT and KPFK** have alert
>    **emails** switched on. WPFW, WBAI and KPFA are switched off **on purpose**.
>    `alerts are switched off for station "…"` on those stations is expected. It
>    is never a cause, a bug, or an action point, and enabling them is not a
>    suggestion to make.
> 2. **"Alert" means EMAIL. The APP is a different thing: the app must catalog
>    EVERY incident for EVERY station**, muted or not. Email muting must never
>    reduce what the dashboard, incident list, history or station reports show.
>    A muted station's outage missing from the app is a bug.
> 3. **A whole-server failure can be real for some stations and false for
>    others.** Judge each station after the fact from Icecast's own record — a
>    mount's `streamStart` (when its source last connected) and its listener
>    count before and after — never from a probe taken from a Mac during
>    recovery. See the 2026-09-12 entry below.

## Where the project is — 2026-09-12 (evening)

**Live, but NOT current: a batch of fixes is built, tested and not yet
deployed.** 5 stations, 10 channels, 3 Icecast hosts. **926 tests pass locally**
(906 at the last audited deploy). `main` is at `0097660`; everything described in
the 2026-09-12 "Pacifica network event" entry below is on top of that, local
until pushed and deployed from Coolify.

**WPFW is down in real life** (its source to `streams.pacifica.org` dropped at
~21:03 UTC and did not return; the engineer has been told). Until the fixes are
deployed, WPFW's station report reads "100% uptime · 0s" and the dashboard does
not show its outage — that is the bug the batch fixes.

**Deploy note:** deploying while an outage is open is now SAFE (a restart resumes
it). Before this batch it was not — every redeploy orphaned the open outage.

Verify a deploy without signing in:

```bash
curl -s https://kpft-icecast.supersoul.top/api/config | jq '.auth, .geo'
# auth: passwordConfigured, sessionSecretConfigured, sessionHours
```

### What exists now, in one paragraph

The monitor watches Icecast streams, names which side of the handoff broke, and
emails only when listeners actually lost audio. On top of that sits an audience
product: reach and listening hours, returning vs new listeners, the device and
player mix over time, where listeners are by state and metro, when each region
listens, and how long sessions last. Everything per-listener needs an Icecast
admin password for that stream's server, and the page says so per channel.
`/api/export` produces one file holding the whole deployment; the admin panel
has Backup & move.

### What is NOT done, in priority order

> **Picking this up? Start at item 0, then item 2.** Item 1 is the most valuable
> thing on the list but is BLOCKED on the owner, and there is no code to write for it.

0. **Ship the 2026-09-12 open-outage batch, then verify it live.** Push, deploy
   from Coolify, then check: `/api/rollup?days=1&stationId=wpfw` shows
   `counts.ongoing: 1` with a non-zero `downtime.streamMs` (while WPFW is still
   down); the dashboard's Recent Incidents leads with WPFW marked ONGOING; the
   startup log says it closed the 18 orphaned 2026-09-02 events; `/api/events`
   shows those 18 with `recoveryObserved: false`.
0b. **Decide: should an unwitnessed whole-server failure email?** KPFK's
   2026-09-12 alert was a false positive — Pacifica's server was unreachable
   from the monitor, so impact was `unknown`, and `unknown` emails by design.
   The same rule got KPFT right. Suppressing `unknown` would also silence a real
   Pacifica crash. The real fix is a second vantage point (a probe from another
   network). Owner's decision — do not change the policy without it.
1. **BLOCKED ON OWNER — Icecast admin credentials for `streaming.wbai.org` and
   `streams.kpfa.org:8443`.** No code required — one env var,
   `ICECAST_ADMIN_CREDS`. This is worth more than any remaining feature: it
   switches on every per-listener figure already built, for two more stations.
   The owner expects the passwords in a few weeks.
2. **A monthly station report.** The two existing exports (audience CSV, history
   JSON) are data dumps for a spreadsheet; nothing produces a DOCUMENT a manager
   can attach to an email. `previewWeeklyRoundup()` already composes this shape,
   so a monthly variant is largely a window change plus the audience figures.
   **It has a deadline.** September is the first COMPLETE month on record
   (recording began 2026-08-04, so August is partial), and it closes
   2026-09-30. Built by then, the first real report can go out 2026-10-01;
   otherwise the first one slips a month. `/api/rollup` already computes the
   right FIGURES — `narrative`, `faultSplit`, listener-hours lost against
   delivered — but only over a window ending NOW: `store.getPeriodRollup()`
   hardcodes `until = Date.now()` (store.js:2771). A monthly report needs
   explicit calendar bounds, 1st to 1st in the STATION's timezone, so the first
   step is a `since`/`until` variant of the rollup. Running `days=30` on the 1st
   is not a substitute: it is off by the hours between midnight and the run, and
   by a day in 31-day months.
3. **Month-vs-month, by name.** Blocked until **2026-11-01**, not by code:
   recording began 2026-08-04, so September is the first complete month and
   October the second. Shipping a comparison whose earlier term is partial is
   the `+376%` artefact wearing a different label.
4. **Help in the admin panel — Phase 9, FIRST TWO STEPS SHIPPED 2026-09-11.**
   `help.css` extracted and loaded by all four pages; popovers on Identifier,
   State and Timezone; a five-topic admin guide reusing the dashboard's
   renderer. Still to do: popovers on the alerts editor, the test-alert button,
   add-to-existing-station, and the two mount warnings — all of which live in
   `admin.js` rather than the markup. Verified 2026-09-12: `admin.html` has 3
   `info-popover`s, `admin.js` has 0. Small and well-scoped. Original scoping
   below:

   **Phase 9, as scoped.** The Audience page has 16
   inline popovers and the dashboard a 14-topic guide; `/admin.html` has NONE,
   and it is the page where a wrong click orphans a channel's history or
   replaces the whole record. One structural decision has to be taken first:
   admin.html loads only `admin.css`, so neither the guide modal (`style.css`)
   nor the popover (`history.css`) is available there. The plan recommends
   extracting a shared `help.css` and closing a gap in `css-classes.test.js`,
   which checks that a class exists in SOME stylesheet but not that the page
   loads it.
5. **Admin panel build-out generally.** The owner wants this to be where
   operational UI lives. Backup & move is there now and is the pattern to
   follow: plain words, the consequence stated before the action, and
   confirmations that name what SURVIVES.

**Parked, not scheduled — SoundExchange royalty reporting.** Researched
2026-09-12 and written up as Phase 10 in
[`docs/PHASE-PLAN.md`](docs/PHASE-PLAN.md) so the work is not lost. The owner's
call: a far-off feature, NOT to be built soon. Do not start it, and do not fold
it into the monthly report.

### Decisions already taken, so they are not re-litigated

| | |
|---|---|
| **One login for all**, until the move to Pacifica production | Phase 7: the split is by SENSITIVITY, not by user. The figures that matter in an emergency need no credential at all |
| **Icecast credentials live in the environment**, not the admin panel | A password belongs to a SERVER, not a person, so it never belongs to a role. Building the entry UI before the access model exists means building it twice |
| **Collect as much as possible** | The owner's explicit position. "Privacy" here means access control and what leaves the server, not limits on what Pacifica gathers about its own audience. Both are already right: detail is behind auth, IPs are hashed and never written to disk |
| **Import always REPLACES** | "Into an empty volume" is impossible — the app seeds config on first boot. Safety is an explicit `replace: true`, a preview endpoint, and displaced files renamed aside |

### The traps that outlive the features

This data is **sampled, tiered and folded**, and each of those does something
different to a figure computed naively over it. Every one of these produced a
plausible, confident, wrong number before it was caught:

| Hazard | What it produced | The rule |
|---|---|---|
| **Tiers smear a boundary** | `returning` went 1 → 2 on identical data purely because compaction ran — loyalty manufactured by a maintenance job | Snap windows to the tier, or refuse. Re-bucket where a coarser answer is still honest |
| **Detail is lost at compaction** | An hour-of-day profile is impossible 48 hours after the fact | Pre-aggregate the cross-tab BEFORE the detail goes. It cannot be backfilled |
| **Repeated sampling is length-biased** | A six-hour session appears in ~72 readings, a two-minute one in at most one | Store per device and reduce; never tally per reading and sum |
| **A gate sized for one claim is wrong for a smaller one** | 200 km is inside one state and spans several cities | Tighten the gate with the claim; degrade to the coarser answer rather than refusing |
| **An absent figure reads as a zero one** | "iOS app is not showing for KPFK" — it was tenth on a list that drew nine | A truncated list must say so, and say why the rest are hidden |
| **An open outage has no duration** | WPFW off air 1h+, ~390 listeners gone; its report: "100% uptime · none lasting more than 0s" | `durationMs` exists only after recovery. Read failures through `store.withOngoingDuration()`, never `e.durationMs \|\| 0` |
| **Episodes live in memory, events on disk** | Every redeploy orphaned the open outage; 18 sat open from 2026-09-02 | Startup runs `store.reconcileOpenEvents()`; anything that gates once-per-episode must be restorable from the event |
| **"All streams" is a per-server question** | Six Pacifica channels failing together read as "Single stream · 6 of 10" | Correlate within one host (`diagnose.serverWideHosts`), never across the fleet |
| **A flag set by the mailer is not "this episode was handled"** | A muted station's one outage counted 3× toward a storm | Gate once-per-episode logic on its own flag, not on `alerted` |

**And the one that would ruin a migration silently:** `deviceSalt` and
`devices.db` are ONE artefact. The hashes are in the database, the salt is in
`events.json`. Separate them and every returning listener hashes anew — cume
jumps by the whole audience and "came back" reads zero for ever, with no error.
`backup.js` refuses a bundle that would do it.

### Conventions worth knowing before editing

- **The Dockerfile copies files individually.** A new top-level module must be
  added to it; `test/dockerfile.test.js` catches this and has, twice.
- **`assert.deepStrictEqual` compares prototypes**, so an array built inside a
  `vm` fails on the prototype rather than the contents. Use `Array.from`, never
  `.map`, on anything out of `vm.runInContext`. This has bitten three times.
- **Backticks inside a JS template literal close it.** The SQL schema in
  `device-store.js` is a template literal; do not wrap words in backticks there.
- **Tests slice page source by anchor strings.** Moving a helper can break tests
  that have nothing to do with it — anchor to a function that follows, not to
  whichever one-liner happens to sit between.
- **Every figure that can be withheld is withheld as `null`, never `0`**, with a
  reason the page renders. "We could not measure it" and "it was zero" are
  different sentences and must never look alike.

---

## 2026-09-12 — The Pacifica network event, and why the app hid WPFW

### What happened (times UTC)

At **20:52:45** all six channels on `streams.pacifica.org:9000` — KPFT Main, HD2,
HD3, WPFW, KPFK and a KPFA channel — failed in the same check cycle, and so did
Pacifica's status endpoint. WBAI's and KPFA's own servers stayed healthy. The
monitor's connections to Pacifica took 3–10 s to connect (retransmit timing) and
stalled after. KPFK recovered at 21:05:45, the KPFT channels at 21:06:45.

Icecast's own record afterwards is what says what listeners experienced:

| Channel | Listeners before → after | Icecast `streamStart` | Verdict |
|---|---|---|---|
| KPFT Main | 157 → 39 | reconnected 21:03 | **real** — encoder dropped; email correct |
| KPFT HD2 | 13 → 7 | reconnected 21:03 | **real** |
| KPFT HD3 | 4 → 2 | — | real |
| WPFW | 388 → 0 | source gone, did not return | **real, still down** (email muted by design — dev phase) |
| KPFK | 112 → 121 | connected since 2026-09-06 | **false positive** — audio never stopped; emailed |
| KPFA (Pacifica) | — | connected since 2026-09-07 | false positive (no recipients) |

Icecast itself did not restart (`server_start` 2026-08-19). So this was a
Pacifica-side network event that dropped some inbound sources and slowed every
outbound connection — real for KPFT and WPFW, not for KPFK.

**A correction, recorded because it will happen again.** The first diagnosis in
this session called the whole thing "the monitor's own network path — the
stations stayed on air", from a probe of Pacifica on a Mac that answered in
<0.5 s. That probe was taken during recovery and could not see the past. It was
wrong for KPFT and WPFW. The source-reconnect time and the listener counts
settled it. That method is now Operating Rule 3 at the top.

### What was wrong in the monitor — six defects, one incident

**1. Cross-stream correlation was fleet-wide.** `diagnose.classify()` asked "did
ALL monitored streams fail?" across every server. With three hosts, six of ten
is never all, so a whole-server event was scoped `stream` — the KPFK email read
"🎚️ Single stream" and "6 of 10 monitored streams are failing". Written when the
monitor watched one server; never made host-aware. Same mistake in
`monitor.js`'s `allDown` (email heading scope) and in the recovery heading, which
called any two recoveries in a cycle "server".
**Fix:** correlation within the stream's own host; `diagnose.serverWideHosts()`
decides server scope for both email headings.

**2. "Detected At 1:54:44 PM PDT CT".** A hard-coded ` CT` from the Houston-only
days, appended after a time that already names its zone. Only instance.

**3. "What a TLS handshake against a plaintext port looks like".** Attached to
every `EDEADLINE`, including this one where TLS had completed. **Fix:** the hint
appears only when TCP connected and TLS never finished, and names congestion as
the other explanation.

**4. A muted station's one outage was counted as a storm.** The storm counter is
once-per-episode and was gated on `episode.alerted` — set only by the mailer,
never for a muted station — so WPFW re-entered it every cycle: 'alert',
'declare', 'suppress'. Its record read "flapping (3 outages)". Persisted, so
enabling WPFW's email later would have silenced its first real outage.
**Fix:** its own flag, `stormNoted`, persisted as `notificationJudgedAt`.

**5. An open outage lasted zero seconds everywhere.** `durationMs` is written at
recovery. Every aggregate read `e.durationMs || 0`: the period report (brief vs
significant, downtime, longest, "What happened", listeners cut off), audio
uptime, the daily off-air calendar, listener-hours lost, the audience-chart
outage bands, and the history page, which totals events in the browser. WPFW —
off air over an hour — read **"100% uptime · 1 brief interruption, none lasting
more than 0s"**. On top of that the dashboard's Recent Incidents shows the newest
eight events; five stations' recoveries pushed WPFW's open outage to tenth, off
the panel. And its feed was a 24-hour window, so an outage on its second day
would vanish from the dashboard entirely.
**Fix:** `store.withOngoingDuration()` gives an open failure a duration to now
and a provisional audience cost, as a copy that is never written back. Applied
where aggregates read events (`getPeriodRollup`, `getAudioUptime`,
`getDailyBuckets`, `getAudienceSummary`), in `monitor.getEvents` (so every page
reading `/api/events` gets it), in the audience bands, and in `getIncidents`,
which now also includes every open outage older than 24 h. The dashboard pins
open outages above everything and labels them "ONGOING — down 1h 14m so far".

**6. Every restart orphaned the outage in progress.** Episodes are in memory;
startup restored stream status but not episodes. The open event stayed open for
ever, and a still-down stream got a second event beside it. **The live record
holds 18 such orphans**, all KPFT Main/HD2, from the redeploys of 2026-09-02.
They were invisible only because of defect 5 — fixing 5 alone would have
reported ten days off air. **Fix:** `store.reconcileOpenEvents()` at startup.
Superseded orphans are closed; a stream's latest open outage waits for the first
cycle, which resumes the same event if still down (no second record, no second
email, failure count and storm state restored) or closes it if healthy. A close
without a watched recovery sets `recoveryObserved: false`, ends at the **last
failed check actually seen** (a lower bound, never an invention), and gets no
manufactured recovery event.

Found while fixing 6, same mechanism: **`settledImpact()` read "no source
reconnect recorded" as "the source held — nobody lost audio"** for ANY resolved
event. That is only valid for a watched recovery. Unobserved closes and
`abandoned` episodes (channel removed while failing) would have been written
off as harmless. Now `unknown` unless the recovery was observed.

### Tests (each fails against the pre-fix code)

- `test/server-scoped-correlation.test.js` — two hosts, one fully down: server
  scope, per-host counts, single-stream host never "server", plaintext hint only
  on a stalled handshake, one zone in "Detected At" for any timezone. 6 of 7
  fail on the old code (the 7th pins that the hint still appears when warranted).
- `test/storm-once-per-episode.test.js` — full check cycles, muted + alerting
  station on one host: one outage counted once. Old code: "counted 3 times".
- `test/open-outages.test.js` — rollup, events feed (and no write-back), 24h+
  open outage on the dashboard, startup closing superseded orphans without a
  manufactured recovery, a REAL restart (modules reloaded from disk) mid-outage
  resuming the same event with no second email, and a stream healthy after
  restart closed as unobserved. All 6 fail on the old code.
- `test/incidents-open-first.test.js` — open outage shown above 12 later events,
  all open outages shown past the row limit, labelled ONGOING. All 3 fail on the
  old `app.js`.

Full suite 926/926 on Node 24.20.0.

### Open

- **KPFK false positive / unwitnessed failures** — item 0b at the top.
- **After deploy**, WPFW's resumed outage keeps its event. Its phantom storm
  state from defect 4 is persisted and ends by itself after 30 min healthy; it is
  muted, so it can send nothing meanwhile.
- The 18 closed orphans will appear in history with durations to their last
  failed check. Those are MINIMUMS; the record says so.

---

## 2026-09-12 — Player/app shows every player

The Player/app list has now been cut three ways — nine rows, then twelve, then
everything at or above a 1% share with the tail behind an expander — and each
version produced the same report: a player the station would act on was not on
the page.

**The expander was the worst of the three, because it looked solved.** The row
read *"12 more, each under 1%"* in tertiary italic (#606078 on a near-black
panel) with a small caret. That is below readable contrast and nothing about it
says "control", so the twelve entries behind it were as missing as they had been
when the list dropped them in silence. Opening it by default was not the fix
either: the owner's position is that a list of players should be a list of
players. A player at 0.4% is still hundreds of people and is precisely the row a
platform decision turns on.

**The fix is one sentinel at one call site.** `bars()` gained `ALL`, and only
Player/app passes it (`bars(players, cume, ALL)`); the list renders every entry
with no remainder row and no control. Platform keeps `6`, metro keeps its eight,
and country keeps the summary it gets from GeoMap — all untouched.

**A process note worth more than the feature.** The first attempt at this
generalised the change to the metro list and the shared remainder styling,
because those have the same flaw. The owner's instruction was explicit — *"ONLY
the Player/App list"* — and the second attempt was reverted to a two-file diff.
The standing rule now: sweep for the class of a bug and REPORT the siblings, but
edit only what was asked. See the memory `change-only-what-was-asked`.

Verification, Node 24.20.0: full suite 906/906. `test/truncated-lists.test.js`
gained five tests pinning the split — ALL renders every entry with no remainder
and no expander, sub-1% entries survive, ALL is opt-in so every other list still
cuts, and the call sites themselves are asserted (`players` passes ALL,
`platforms` still passes 6) so the exemption cannot silently spread or silently
lapse. One trap found while writing them: a top-level `const` in the module lives
in the vm script's declarative scope and does NOT come back on the context
object, so the tests were reading `ALL` as `undefined` and exercising the cut
path while claiming to test the uncut one. `load()` now reads it out
deliberately.

Docs corrected in the same pass, because both described behaviour that no longer
exists: the in-app guide told readers Player/app shows "a top few" and that the
1% line applies to it, and README §"Ranked lists say when they are truncated"
said the same and additionally still claimed the tail opens collapsed.

Status: code in `04b11a0`, doc corrections in `d72b5b1`; both pushed, both CI
jobs green, and production serves both — verified by fetching the live
`/listeners.js` (ALL call site present) and `/guide.js` (new Player/app copy
present, stale "each show a top few" gone).

Next: unchanged — the monthly station report is the largest outstanding code
item. See "What is NOT done" at the top.

---

## 2026-09-11 — Backup & move, in the admin panel

Export and import now have a UI, last on `/admin.html` because it is used rarely
and is the one control in the product that can destroy the record.

The shape is deliberate. Choosing a file does NOT restore it: the file is read,
described — stations, channels, incidents, listener records, when and where it
was made — and only then is a Replace button rendered, behind the same
confirmation every other destructive action here uses. That confirmation states
what SURVIVES (the displaced files are renamed and kept; anything outside the
data folder is untouched) rather than asking a question the reader cannot answer.

The export says out loud when it cannot carry the salt. A deployment that sets
DEVICE_HASH_SALT itself keeps the salt outside the volume, so the file looks
identical to a complete one until the day it is restored — that case is reported
in the error style, naming the variable.

Two browser-specific traps handled: base64 is chunked at 0x8000, because a
one-shot `String.fromCharCode` over a multi-megabyte array overflows the
argument stack and fails silently on exactly the large backups that matter; and
the file input is cleared after each pick, or choosing the same file twice fires
no change event and the panel appears dead.

Verification, Node 24.20.0: full suite 863/863. New `test/admin-backup-ui.test.js`
(11) pins the ordering (preview before import, confirmation before the request),
the wording about what survives and the restart, the salt warning, the chunked
base64, and that the panel is last on the page. Driven through a real browser
path against a running server: login, panel present, export with
`X-Device-Salt-Included: yes`, preview returning counts (86 device rows), and
import refused without `replace: true`.

Status: local and tested, NOT committed at the time of writing.

Next: the owner asked what OTHER exports would serve station management. The two
existing ones (audience CSV, history JSON) are data dumps for a spreadsheet.
Nothing produces a DOCUMENT — see the proposal in the next session.

---

## 2026-09-11 — Phase 8a/8b built: export and import

One gzipped JSON bundle carries the deployment's whole state — configuration,
events, telemetry and the device database. `GET /api/export`,
`POST /api/import/preview`, `POST /api/import`. New module `backup.js`, and
`DeviceStore.snapshotTo` (VACUUM INTO, because WAL mode makes a plain file copy
short and it opens fine anyway).

It is also the backup this deployment did not have.

TWO THINGS THE END-TO-END TEST FOUND, both of which would have shipped:

1. **The salt guard was too strict.** A deployment with listener detail off, or
   one that has never run a pass, has an EMPTY devices.db and no salt — the salt
   is created the first time a device is hashed. Refusing that bundle blocked a
   migration with nothing to lose. The rule now keys on device ROWS: refuse when
   there are identities to orphan, allow when there are none, and treat an
   exporter that cannot count as "assume there are" — a wrong refusal is an
   inconvenience, a wrong import is unrecoverable.

2. **"Import into an empty volume" is impossible**, which was the original 8b
   and is now corrected in the phase plan. The app seeds its configuration on
   first boot, so by the time an operator can sign in to import, the volume is
   occupied. A safety rule nobody can obey just gets worked around. Import is
   always a replace; the safety is an explicit `"replace": true`, the preview
   endpoint, and displaced files RENAMED ASIDE rather than deleted. There is no
   8c.

A THIRD, found while writing the test rather than by it: `store.deviceSalt()`
prefers `DEVICE_HASH_SALT` when set, and then the salt is never written to the
volume at all. So it could not travel in a bundle AND it was missing from the
env checklist — the single most important variable to carry. It is now first on
that list, the manifest reports `saltSource: 'environment'`, and validation
warns loudly rather than refusing, since refusing would block every deployment
that sets it.

Also caught, by the existing suite rather than by me: `backup.js` was not in the
Dockerfile. That is the trap this HANDOFF already warns about — the Dockerfile
copies files individually — and `test/dockerfile.test.js` exists for exactly it.

Verification, Node 24.20.0: full suite 852/852. New
`test/backup-bundle.test.js` (28) covers the salt refusal and its wording, the
round trip proving a listener recognised before the move is recognised after,
credential stripping at any depth, that no secret VALUE is exported, checksums,
a newer-schema refusal, replace-not-merge, stale WAL sidecar removal, and that a
rejected bundle writes nothing at all. Two live servers were driven end to end:
export from one, import into the other with `"replace": true`, restart, verify.

NOT BUILT: a UI. Export and import are API-only for now, which suits a move done
once by the person who also sets the environment variables. A button belongs
with the admin panel work.

Status: local and tested, NOT committed at the time of writing.

---

## 2026-09-11 — Session length (roadmap §4.5 item 5) — §4.5 IS COMPLETE

TSL is the engagement metric station managers say they watch. Reach says how
many; this says whether they stayed, and a station can grow its audience while
losing engagement — which nothing here could show, because session figures came
only from the live snapshot and could not be trended.

THE TRAP, and the reason this is stored per device rather than tallied per
reading. Listener detail is read every few minutes. Summing what each reading
sees is LENGTH-BIASED: a six-hour session is present in about seventy-two
consecutive readings and a two-minute one in at most a single reading. That
distribution reports an audience staying far longer than it does, and the error
grows with exactly the quantity being measured — a confident, flattering,
entirely wrong engagement figure. So the band is stored ONCE PER DEVICE and
RAISED to the longest session seen; a listener sampled seventy-two times counts
once.

CHEAPER THAN THE ROADMAP ASSUMED. §4.5 called this "the only item that increases
what is collected per listener" and proposed a frozen per-day aggregate. Neither
was needed: the band is one small integer on the device row, like `place` —
0-5, or -1 for not recorded — folded by MAX through every tier. No new table,
and nothing proportional to how often the audience is sampled, so the volume
question in §4 of ADMIN-ACCESS-SCOPE.md does not arise.

`INSERT OR IGNORE` became an upsert, because `sess` GROWS. Ignoring the second
row would freeze every session at whatever it was when the listener was first
noticed. Only `sess` is raised: `cls` and `place` derive from the IP and user
agent the device hash is made from, so they cannot change for a given device.

"Not recorded" (-1) is deliberately not band 0. Icecast sometimes sends no
Connected field, and "we did not measure this" and "listened for under a minute"
are different answers — averaged together they make an unmeasured audience look
like a bouncing one.

Verification, Node 24.20.0: full suite 823/823. New
`test/session-length.test.js` (12), including the bias case driven as twelve
consecutive readings of one growing session, the raise-never-lower rule,
survival through the fold, legacy rows, and that the bands always sum to the
measured count. One failure during development was my own arithmetic — 21600s is
exactly six hours and lands in the 6h+ band, not 1-6h. Booted on a scratch data
dir: clean, migration runs, no SQL error.

Also fixed: the same backtick-inside-a-JS-template-literal slip as the schema
comment on 2026-09-10. Third time a word wrapped in backticks has closed a
template literal early in this file — do not use them in SQL comments here.

§4.5 IS NOW COMPLETE. The roadmap carries a table of the four hazards these five
items surfaced — tier smearing, detail lost at compaction, length-biased
sampling, and a gate sized for the wrong claim — which is the part worth reading
before computing anything else over this data.

Status: local and tested, NOT committed at the time of writing.

---

## 2026-09-11 — Metro-level geography (roadmap §4.5 item 4)

The number this corrects: a licence covers a METRO, and the map counts a whole
STATE. "In Texas" includes Dallas, so the in-market figure reads high and
"outside our signal area" — the figure that justifies streaming to a board —
reads low.

THE GATE IS TIGHTER THAN THE STATE'S, which is the whole safety of it.
`GEOIP_MAX_CITY_ACCURACY_RADIUS_KM` defaults to 50 km against the state's 200.
200 km is sound evidence for a state — it is inside one — and worthless for a
city, since that far from Houston reaches Austin. A record that clears the state
gate but not the city one KEEPS ITS STATE and loses only its city: a place named
at the resolution the evidence supports. No state means no city either, because
such a record was already too vague; outside the US there is no city, exactly as
there is no state; and a database with no `accuracy_radius` at all (DB-IP City
Lite) publishes neither.

A BOUNDARY WAS DELIBERATELY MOVED, and it had a test defending it.
`test/geo.test.js` asserted "THE BOUNDARY: no city name survives a lookup", on
the grounds that the published resolutions were state and country. That was
correct while city was out of scope. It is now seven tests describing the
narrower rule, and the revision is recorded in the file itself.

THE COORDINATE BOUNDARY IS UNTOUCHED and must never move — no latitude or
longitude survives a lookup, so a dot-per-listener map stays impossible to build
downstream by accident. Counts per metro are not pins, and §3 of
ADMIN-ACCESS-SCOPE.md still rules pins out.

Cities are keyed `TX/Houston`, never by bare name: there is a Houston in Alaska,
a Paris in Texas and a Portland in two states at once. The stored token gains a
third segment ('US:TX:Houston'); readers that split for country and state are
unaffected, and MAX(place) still prefers the more informative token because a
longer string sharing a prefix sorts above the shorter one. A colon in a city
name is replaced rather than escaped, so it cannot shift every reader's parse.
Two-segment tokens written before this still read correctly and report the city
as withheld, which is exactly right for them.

DELIBERATELY NOT BUILT: an in-market share computed against a station's own
metro. It needs a per-station metro setting whose value must match the geo
database's city string exactly, and a near-miss produces a confident wrong share
rather than a visible error. The metro LIST beside the state figure answers the
same question without that fragility — shares use the same denominator as the
in-market tile, so "412 of Texas's 700 are in Houston" can be read directly
against it — and can be promoted later if it earns it.

Verification, Node 24.20.0: full suite 811/811. New
`test/city-resolution.test.js` (11) covers the token, the colon, non-US, legacy
two-segment tokens, MAX precedence, the state/city key, that a metro count can
never exceed its state count, merging, and that the gate sits exactly at the
configured radius. `test/geo.test.js` gains seven. Booted on a scratch data dir:
clean.

Status: local and tested, NOT committed at the time of writing.

Next: item 5, session length — as six DURATION_BUCKETS per day frozen at
compaction, like `region_hours`, not a duration per listener.

---

## 2026-09-11 — An Icecast admin credential per HOST

The owner asked whether a mechanism existed to switch advanced figures on for a
station once its Icecast admin password arrives. It did not: credentials came
from ICECAST_ADMIN_USER/PASSWORD scoped to the single `adminHost()`, and there
is no credential field anywhere in the admin panel. WBAI's and KPFA's passwords
would have had nowhere to go.

DECIDED WITH THE OWNER: environment variables now, admin panel later. The
passwords are several weeks away, and `AUDIENCE-ROADMAP.md` §4.1's design —
entered in the station setup flow, stored against the host — collides with a
decision the owner is deliberately deferring: per-user accounts and roles, to be
settled at the move from this dev deployment to Pacifica production. Who may
enter a credential, see that one exists, or rotate it are role questions.
Building the entry UI first means building it twice.

`ICECAST_ADMIN_CREDS` is JSON, host → {user, password}. The single-host pair
still works unchanged; the map wins where a host appears in both, so a
credential can be corrected without touching it. One server's password is never
sent to another — the scoping test asserts this directly.

A REAL BUG THAT ENABLING MULTI-HOST WOULD HAVE INTRODUCED, found before it
shipped: `collectListenerDetail` declared its address Set and assigned
`listenerDetailMeta.host` INSIDE the per-host loop, so with three credentialed
hosts the last server's distinct-address count would have been reported as the
whole collection's — a silently smaller number with nothing to show why. The Set
now spans the pass (one household listening to two of the network's stations is
one address, which is what the figure is for) and `hosts` carries every server
read, with `host` kept as the first for anything still reading it.

Verification, Node 24.20.0: full suite 794/794. New
`test/icecast-credentials.test.js` (11) covers per-host scoping, backwards
compatibility with the single-host pair, precedence, malformed JSON, half-filled
entries, arrays and bare strings, and that `credentialedHosts()` returns
hostnames and never a password. Hostnames are not secret — they are already in
the public station config, and naming the server is what makes the coverage band
actionable.

OWNER ACTION when the passwords arrive: add them to ICECAST_ADMIN_CREDS in
Coolify. No code change, no redeploy of anything else. Every per-listener figure
already built then switches on for WBAI and KPFA Berkeley.

Status: local and tested, NOT committed at the time of writing.

Next: roadmap §4.5 item 4 — city-level geography behind a tighter accuracy gate.

---

## 2026-09-11 — Which figures need an Icecast admin password, said once

The owner asked how to signal credential-gated figures without the UI becoming a
mess, and corrected a wrong assumption of mine: WBAI is NOT on Pacifica's host.
Verified against the live configuration:

    streams.pacifica.org:9000   CREDENTIALED   kpft x3, wpfw, kpfk, AND one kpfa channel
    streaming.wbai.org          none           wbai x3
    streams.kpfa.org:8443       none           kpfa-kpfa-berkeley

THE CORRECTNESS BUG THIS EXPOSED, which is more than a UX問題. Listener detail is
collected only from hosts with a credential (`collectListenerDetail` filters on
`adminCredsFor`), but `streamIdsFor('kpfa')` returns BOTH channels. So KPFA's
individual-listener, returning, geography and daypart figures covered the HiRes
stream alone and were presented as the station's. An understated number shown as
a whole one is worse than a missing one: nobody goes looking for it.
`/api/listener-detail` now returns `detailCoverage` — per channel, each with its
host and whether it is covered — and the page states "These figures cover 1 of 2
channels" and names which is missing.

THE SECOND BUG: the page HID rather than marked, which is the opposite of what
`docs/ADMIN-ACCESS-SCOPE.md` §4.1 already decided ("SHOWN, marked unavailable —
never hidden. A missing panel teaches nobody anything"). `renderDeep` replaced
the whole section with one box and returned, so a reader on an uncredentialed
station never learned the product could do any of it — and no-credentials is the
COMMON case for an affiliate, not an edge one. Gated figures now render present
and empty with a key.

THE DESIGN, for whoever changes it next:
- **Said ONCE**, at the top of the gated section. Per-panel notices are a wall of
  apologies that a reader learns to scroll past, which is the opposite of
  informing them. Individual figures carry a small key glyph instead.
- **The host is named**, because the fix is per host and "unavailable" tells an
  operator nothing they can act on.
- **Three states, worded and styled apart.** "Sign in" is about the READER and
  takes ten seconds; "no admin password" is about the DEPLOYMENT and needs a
  station engineer. One grey box for both sends the first reader to the wrong
  person. The partial case carries the accent colour, because it changes how a
  number already on screen should be read.
- **Not styled as an error.** A station whose server somebody else runs is the
  normal case; an amber box would tell an affiliate their install is broken.

Verification, Node 24.20.0: full suite 783/783. New
`test/coverage-band-render.test.js` (8) pins all three states including the KPFA
split, that one host is named once for three channels, and that the band never
says "Sign in". `test/audience-refresh.test.js` gains a 'split' station — one
station, two channels, two servers, a password for one — as a permanent test of
the shape. A new `access` guide topic states the one-sentence rule, both lists,
that the password belongs to the SERVER not the station, and that the two gates
are different problems; `test/guide-topics.test.js` asserts those survive edits.

Also fixed here: two more cross-realm `assert.deepStrictEqual` failures on arrays
built inside a `vm`. That is now the third time — the rule is `Array.from`, never
`.map`, on anything coming out of `vm.runInContext`.

Status: local and tested, NOT committed or deployed.

Next action: commit and push. Four commits now await deployment: b91388e,
9710b18, ebf6155 and this one.

---

## 2026-09-11 — Two sign-in faults, neither of them in the login

Reported by the owner: "login is not persistent and I keep needing to log in
again", and "when I log in on the listeners page it sends me back to the site
front". Different causes; both fixed.

THE RETURN PATH. `public/listeners.js` linked to `/login.html` with no `next`,
so `login.js` fell back to '/'. Every other caller passes it — `admin.js` builds
`?next=` on a 401, and its logout deliberately does not. One link. It now passes
`pathname + search`, so the selected STATION survives the round trip too;
arriving back at a different station would be its own small bug.

`login.js` already refused anything but a same-origin path, which is what makes
accepting `next` safe at all. Now tested, since it is being fed user-visible
data: absolute URLs, protocol-relative `//host` and `javascript:` all fall back.

THE SESSIONS. Almost certainly `SESSION_SECRET` unset in Coolify: auth.js
generates an ephemeral one at boot and warns that sessions will not survive a
restart. A redeploy is a restart, and this deployment has had many today. I
cannot read the production environment, so this is not asserted from evidence —
it is the only mechanism that produces exactly this symptom.

What IS fixed is that the fault was invisible. The warning goes to a container
log; from outside, a deployment with no secret is indistinguishable from a
healthy one until it forgets you. `/api/config` now carries an `auth` block
beside `emailConfigured` and `geo` — `passwordConfigured`,
`sessionSecretConfigured`, `sessionHours`, booleans and a duration, never a
secret or a hash on a public endpoint. Checked with:

    curl -s https://<host>/api/config | jq .auth

OWNER ACTION: if `sessionSecretConfigured` is false, generate one
(`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) and
set SESSION_SECRET in Coolify. Changing it later signs everybody out, which is
also the deliberate way to do that.

Verification, Node 24.20.0: full suite 775/775. New `test/sign-in-return.test.js`
(8) covers the link, the station surviving the round trip, the open-redirect
guard, and that the capability flag reports the fault without leaking anything.
README's "Admin authentication" section now states that SESSION_SECRET is not
optional in production and how to check it.

Status: local and tested, NOT committed or deployed.

---

## 2026-09-11 — When each region listens (roadmap §4.5 item 3)

The daypart question, and the one §4.5 item that needed NEW STORAGE rather than
a new query. Items 1 and 2 are committed as `b91388e`.

THE DECISION, taken deliberately because it cannot be revisited later. The
previous handoff framed this as a choice between restricting to the hour tier
(48h) and reading day-resolution data while calling the hour approximate.
Neither is good enough. Two days cannot tell a weekday from a weekend — on this
record weekends average 69-78 against 43-47 on Monday and Tuesday, so a profile
from whichever two days were in range could be wrong by half. And an approximate
hour is not a daypart: the hour IS the question.

The third option is the one the app already uses for tune-ins, which are frozen
onto each hour's rollup as samples compact "because the churn is unrecoverable
afterwards". `region_hours` is written in the same compaction pass, BEFORE the
fold, while exact per-hour rows still exist. An aggregate — a few hundred rows a
day, not one per listener — kept for ever, so the profile improves indefinitely.

Dayparts are how radio is scheduled and sold, which is why this was worth a
table.

RULES, each with a test:
- **Frozen before the fold, in the same pass.** Afterwards the hour is gone.
  There is no backfill: the record begins when recording begins and the panel
  says so.
- **The hour is the STATION'S, converted per day.** One offset across a range
  puts an hour of October in the wrong column every year. `stationTz()` already
  answers UTC for a selection spanning zones, which is the only honest answer
  for "all stations".
- **Each row is shaded against its OWN peak.** On a shared scale the home state
  fills every row and everywhere else is an empty strip — answering "who is
  biggest", which the map already answers, and hiding the question asked here.
- **It measures WHEN listening happens, not how many people.** A listener
  present from seven to nine is in both hours; the hours must never be summed.
- Relays and unplaceable addresses excluded as on the map; non-US at country
  resolution.

The live tail and the frozen record cannot overlap: the fold deletes what it
freezes in the same pass, so they are disjoint by construction and simply added.

Verification, Node 24.20.0: full suite 767/767, zero failures. New
`test/region-hours.test.js` (14, passing first run including the daylight-saving
case) and `test/region-hours-render.test.js` (12). Booted on a scratch data dir:
table created, no SQL error, `/api/listener-detail` answers 401 behind its gate.

One bug while building, caught by `node --check`: a JS template literal holding
the schema had a word wrapped in backticks inside an SQL comment, which closed
the literal early.

Docs: README gains "When each region listens"; the roadmap marks item 3 shipped
and records the general rule — for anything finer than the surviving tier the
answer is not "refuse" and not "approximate" but **pre-aggregate the cross-tab
before the detail is lost**, and that decision must be made before the data ages
out. Remaining: 4 (city) and 5 (session length), both still needing a deliberate
decision first.

Status: local and tested, NOT committed or deployed.

Next action: commit, push, confirm CI, deploy. The panel will be empty until the
first compaction pass has frozen an hour — within `DEVICE_HOUR_RETENTION_H`
(48h) of deploying.

---

## 2026-09-11 — Player and device trends over time (roadmap §4.5 item 2)

Built alongside item 1 and, as the roadmap predicted, needing no new collection.
`kind` was not stored either and did not need to be: every rule in PLAYER_RULES
maps one family to exactly one kind, so `kindForFamily()` recovers it from data
already written. Rolled up server-side, because shipping the table to the page
would be a second copy to keep in agreement with the first.

Grouped by KIND, not by player: "smart speakers went from 8% to 22%" is a
platform decision, "Sonos 4%, Alexa 3%, Chromecast 1%" is trivia.

FOUR RULES, each preventing a chart that would look like a finding:

- **The bucket size is chosen by the data.** Month-tier rows carry the month's
  start as their timestamp, so bucketed by day a year of history renders as
  twelve enormous spikes on the 1st. A range touching compacted records is
  reported monthly and the panel says why. This is the complement of item 1's
  rule: refuse when a boundary cannot be drawn honestly, RE-BUCKET when it can.
- **The period still running is excluded.** "This month so far" against eleven
  finished months is a collapse that did not happen.
- **Fewer than three finished periods draws nothing** and says so.
- **The headline names what MOVED, not what is biggest** — otherwise it reports
  "phone apps are 61% of listeners" every week for ever.

TWO BUGS THE TESTS CAUGHT, both mine:

- `complete` was judged against `Date.now()` rather than the caller's `untilMs`,
  which ignores the passed clock. Same class as the date-sensitive CI failures
  of 2026-09-10: untestable at a fixed time, and quietly wrong for any query not
  ending at this instant.
- The headline tie-break compared deltas exactly. In a two-category mix every
  delta is the mirror of the other, so ties are the NORMAL case — but
  `0.7 - 0.9` is -0.20000000000000007 while `0.3 - 0.1` is 0.19999999999999998,
  so the headline went to whichever mirror image carried the larger rounding
  error. It announced "phone apps fell from 90% to 70%" where the news was
  "smart speakers grew from 10% to 30%". Tied now means tied to the nearest
  displayed percentage point, and a tie goes to the category that rose.

Verification, Node 24.20.0: full suite 741/741, zero failures. New
`test/device-trend.test.js` (12) and `test/device-trend-render.test.js` (9) —
the second exists because this panel makes a claim in WORDS, and a sentence is
worth testing in a way a chart is not. Its assertions run against the text with
markup and template indentation stripped; matching raw HTML tests line wrapping
rather than the claim. Booted on a scratch data dir: clean, no SQL preparation
error, `/api/listener-detail` answers 401 behind its gate.

Docs: README gains "How they listen, over time" with the four rules; the roadmap
marks item 2 shipped. Recorded there for whoever builds item 3: an hour-of-day
cross is finer than a DAY bucket and, unlike item 2, has no coarser bucket to
fall back to — the question IS the hour. It must either restrict itself to the
hour tier (`hourRetentionH`, 48h) and say so, or read day-resolution data and
state that the hour is approximate. Decide before building.

Status: local and tested, NOT committed or deployed. Carries item 1 from the
entry below, also uncommitted.

Next action: commit and push both items, confirm CI, deploy.

---

## 2026-09-11 — Returning vs new listeners (roadmap §4.5 item 1)

Built from data already in `devices`: no new field, no new lookup, no new
collection pass. `getReturningDevices()` intersects the distinct devices of a
window with those of the equal window before it. Surfaced in the SAME
`/api/listener-detail` response as the period it describes — a second request is
how two panels end up describing two different moments — and rendered as TWO
tiles, "Came back" and "First time", not one ratio: retention and growth are
different questions, and a single share hides the second entirely (a period can
keep every regular, reach nobody new, and the percentage goes UP).

THE LIMIT THIS WORK FOUND, and it applies to everything period-over-period that
reuses this table. Buckets age hour → day → calendar month. A device folded into
a month bucket overlaps any 30-day window, so it lands in BOTH halves of a
comparison and reads as a loyal returning listener. Measured on identical data:
`returning` was 1 before `compactDevices` ran and 2 after. Two rules follow:

- **Windows snap to whole days.** Day buckets divide exactly at midnight; a
  boundary at 09:47 falls inside one and the listener in it belongs to both
  periods. It is also the question actually being asked.
- **A comparison reaching the month tier is WITHHELD** (`resolution-too-coarse`).
  No snapping fixes a calendar month cut by a 30-day boundary.

Plus the gate that was the point of the feature: if the EARLIER period was not
recorded, everyone in it is missing, so everyone now counts as new and a
recording gap renders as a surge of first-time listeners. Withheld as null with
a reason, never zero — "we could not measure it" and "nobody came back" are
different sentences, and the card says which.

"Came back" is a FLOOR and is labelled so: a listener whose connection changed
address between the periods reads as new, so real loyalty is higher, never lower.

Verification, Node 24.20.0: full suite 720/720, zero failures. New
`test/returning-listeners.test.js` (12) covers the split being exhaustive, both
withholding gates, station scoping, one person on two channels, the day fold,
the month-tier refusal and the snapping. Booted on a scratch data dir: clean
start, no SQL preparation error, `/api/listener-detail` answers 401 behind its
gate.

Two existing tests needed updating, both legitimately: `audience-refresh`'s
`monitor` stub predated the new call, and `geo-coverage-notice` sliced the page
source using `const plural =` as a boundary marker — moving that one-line helper
broke seven tests that have nothing to do with it. It is now anchored to
`renderGeo`, the function that actually follows the one under test.

Docs: README gains "Returning and new listeners" with the four rules;
`docs/AUDIENCE-ROADMAP.md` §4.5 marks item 1 shipped and records the tier limit
for items 2 and 3 — note that item 3 (time of day by region) is finer than a day
bucket, so it is exact only inside the hour tier (`hourRetentionH`, 48h) and must
say so or refuse. The in-app guide's Audience topic explains both tiles, why
they are separate, why "Came back" is a floor, and why either can be blank.

Status: local and tested, NOT committed or deployed.

Next action: commit, push, confirm both checks, deploy. The figure will be
withheld at first — recording reaches back far enough for a 24-hour comparison
within two days, and a 7-day one within two weeks.

---

## 2026-09-11 — Session close: audit, documentation, in-app help

All three code commits from this session are deployed and verified live:
`73a0f5b` (uptime tile), `8683177` (geography over a period), `16557ba`
(per-station region). Both GitHub checks pass on `16557ba`, the tree is clean
and in sync with origin, and the served `listeners.js`, `app.js` and
`history.js` are byte-identical to local HEAD. `admin.js` differs only because
it 302s to the login page for an anonymous request — the gate working.

AUDIT FINDINGS, both fixed here:
- `getDistinctDevices` early-returned a NARROWER object for a station with no
  channels, omitting `places`. One case where a key is missing is how that one
  case stops being handled. It now returns the full shape, with a test.
- The coverage notice described relays as "people with a location". A relay was
  looked up and excluded; it is not a located person. Reworded to "counted after
  location recording began", which is what the count actually measures.

Checked and NOT a problem: `lookupNetwork` and `lookupPlace` both catch
internally and return miss objects, so `placeToken` cannot throw and cannot take
down a collection pass.

SWEEP for the class of the region bug — a per-station figure derived from a
deployment-wide value. `STATION_TZ` is the only other such value and is already
used as `stream.stationTimezone || STATION_TZ` everywhere; monitor.js:3521
carries a comment saying the global "dates from the single-station install and
is simply wrong". Timezone had already been fixed this way. Region was the only
holdout. Nothing else found.

DOCUMENTATION: README's "Where the audience is" now covers the two maps, why
geography cannot be backfilled, and the per-station state; `STATION_REGION` is
in the env reference for the first time, documented as single-station only.
`docs/ADMIN-ACCESS-SCOPE.md` records the `devices.place` schema. `docs/DEVLOG.md`
has the session entry. `docs/AUDIENCE-ROADMAP.md` §4.5 is the plan for the next
session — five additions, THREE of which need no new collection at all because
the data is already in `devices` and has never been queried.

IN-APP HELP: a new "Where the audience is" topic in `public/guide.js` — the two
maps and why their numbers differ so much, why history cannot be filled in
backwards, that in-market is a state and not a signal area, that each station
carries its own, why relays and low-confidence states are excluded, and what is
never collected. `test/guide-topics.test.js` is the FIRST test of any kind over
the guide, which is one large literal array with no build step: a stray quote or
a missing field failed silently in the browser with every test still passing. It
immediately reported a duplicate id, which turned out to be the test's own bug —
`assert.deepStrictEqual` compares prototypes, and an array built inside a `vm`
context carries that realm's `Array.prototype`. Use `Array.from`, not `.map`.

Verification, Node 24.20.0: full suite 708/708, zero failures.

OWNER'S POSITION ON DATA, stated explicitly and recorded so it is not
re-litigated: collect as much as possible. Privacy here means access control and
what leaves the server, not limits on what Pacifica gathers about its own
audience. Both of those are already right — listener detail is behind auth, and
the raw IP is used for the geo/relay lookups and the salted hash and is never
written to disk (verified: seven uses, all in-memory). Do not raise collection
itself as a concern.

Status: docs, guide, the two audit fixes and their tests are LOCAL and
uncommitted. No production change since `16557ba`.

Next action: commit and push the documentation and guide work. Then §4.5 of the
audience roadmap, starting with returning-vs-new listeners.

---

## 2026-09-10 — In-market share was a deployment's figure, not a station's

The owner selected WPFW — Washington DC — and the panel reported "In Texas 0%,
0 of 59 located US connections. Outside TX: 59."

ROOT CAUSE, pre-existing and not introduced by the new map, which merely
inherited it from the live one:

    homeRegion: () => (process.env.STATION_REGION || '').trim().toUpperCase()

One env var for the whole install. Correct for the single station it was written
for; silently wrong for every station added since. The failure is the dangerous
kind — no error, nothing blank, just a confident figure that is entirely false.
"0% of our audience is in our own state" is a sentence a manager would act on.
The comment above the call site already claimed `homeRegion` was "the station's
own state", which it had stopped being. Recorded in memory as a known gap.

FIX. `region` is now a station property, carried on the channel exactly as
`timezone` is and for the same stated reason. `homeRegion(stationId)` returns
the station's own value; STATION_REGION survives only as the fallback for an
install with exactly ONE station, since a deployment-wide value cannot be true
of more than one and is therefore true of none. "All stations" correctly reports
no home region — it spans three states. A station with nothing configured gets
no figure, which beats a false one.

Configuration: `region` validated in both `validateStationPayload` and
`validateStationEdit` against a 51-entry list (50 states plus DC), upper-cased,
with blank a legitimate answer rather than an error. An edit that does not
mention the region keeps it, so renaming a station cannot blank its state. Added
to BOTH admin forms — the add-station flow and the station editor — since the
five Pacifica stations already exist and only the editor can reach them.

Verification, Node 24.20.0: full suite 703/703, zero failures (6.39 s). New
`test/station-region.test.js` (11); 7 of them fail against HEAD. The last is a
drift guard asserting the accepted codes and `GeoMap.GRID` are identical in both
directions — a code that validates but has no tile would vanish, and a state on
the map that configuration rejects would be unreachable.

THE OPERATOR MUST STILL SET THEM. Existing stations have no region stored, so
until someone fills each one in, the panel shows "Set this station's state in
the admin panel" instead of an in-market share. That is deliberate: guessing a
state from a call sign is how the wrong one gets stored and believed.

Files: `monitor.js`, `server.js`, `discover.js`, `public/admin.html`,
`public/admin.js`, `public/listeners.js`, `test/station-region.test.js`,
`HANDOFF.md`.
Status: local and tested, NOT committed or deployed. Carries the uncommitted
coverage-notice correction from the previous entry.

---

## 2026-09-10 — The coverage notice contradicted itself in production

Shipped as `8683177` and seen live: "Location has been recorded for 7 days of
the last 7 days, so this map covers part of the period rather than all of it."
That states full coverage and partial coverage in one sentence, on the one panel
whose whole job that week was explaining why a number looked small.

ROOT CAUSE. `period.coveredFrom` is when DEVICE recording began — years, in a
mature deployment. `places.coveredFrom` is when LOCATION recording began, which
is the day the column shipped and can never be backfilled. The first was read as
the second. The "part of the period" clause was meanwhile triggered by an
entirely different condition (devices with no location), so the two halves of
the sentence were describing two different things.

The owner's reading was correct: the total is small because it just started.

FIX, in the shape of the lesson. The store now reports the two dates separately
(`placesEarliest`, `MIN(start_ms) WHERE place != ''`), and the notice is driven
by COUNTS of listeners with and without a location rather than by date
arithmetic — "2 people of 1,247 in this period have a location; the other 1,245
listened before location recording began." A count cannot contradict itself, and
it reaches zero on its own as pre-feature rows age out of the window, so the
notice still retires unaided and now does so on the devices rather than a clock.

A short location record covering everyone currently in the range is no longer
called partial, which is right: that map is complete.

Verification, Node 24.20.0: full suite 692/692, zero failures (6.50 s).
`test/geo-coverage-notice.test.js` rewritten around the new semantics — its
fixtures set device recording 400 days back in EVERY case, so if that value ever
leaks into the notice again the tests break. Three store tests added for the new
field, including that a relay counts as located (the lookup ran; the answer was
"exclude"), not as unrecorded.

Files: `device-store.js`, `public/listeners.js`,
`test/geo-coverage-notice.test.js`, `test/device-geography.test.js`, `HANDOFF.md`.
Status: local and tested, NOT committed or deployed. This corrects `8683177`,
which IS live.

Next action: commit, push, confirm both checks, deploy, hard-reload the tab.

---

## 2026-09-10 — Geography over a WINDOW, not only this instant

The owner's question — "why are these numbers so low" — was not a bug. The map
read the live Icecast snapshot (77 connections) under a heading that said seven
days (peak 1,060). But a snapshot is not the figure a general manager reports,
so the answer was to build the one that is: distinct people over the selected
range, with where they were. The owner asked for both views, an obvious way to
switch, and a "still collecting" explainer that can go away later.

WHY IT WAS NOT ALREADY POSSIBLE. Icecast reports where its current listeners are
and keeps no history. `device-store.js` already stored WHO listened, permanently
and at three tiers, but had no geography column at all — the place was looked
up, drawn, and discarded. Crucially the lookup already happens in the SAME loop,
on the SAME rows, that writes the device record (`monitor.js`), so no new
lookup, data source or service was needed: only somewhere to put it.

`devices.place` is one compact token per device per bucket — '' never recorded,
'-' relay excluded, '?' unplaceable, 'US:MD' placed with a state, 'US:' state
withheld by the centroid guard, 'GB:' non-US country only. `placeToken()` in
listener-detail.js produces it by calling the same `classifyChannel` and
`lookupPlace` the live panel calls, in the same order, so the two maps cannot
disagree about who counts. Never a city, never a coordinate — unchanged.

THREE THINGS THAT WOULD HAVE FAILED SILENTLY, all now tested:
  - `compactDevices` folds hour→day→month. Not carrying `place` would have left
    the map working at 24 hours and quietly empty at 30 days.
  - An existing deployment has a permanent table with no `place` column and rows
    that cannot be re-collected. ALTER TABLE ADD COLUMN migrates it; those rows
    read as `unrecorded`, held apart from `unplaced`, because "never written
    down" and "could not be placed" would otherwise understate located share
    for ever.
  - `MAX(place)` in the distinct query, not MIN: tokens sort 'US:MD' > '?' > '-'
    > '', so a device placed on ANY channel is placed.

INTERFACE. `getDistinctDevices` returns `places` in the SAME shape the live
panel publishes, so one renderer draws both and the views cannot drift. The
section carries a two-button choice — the range name, or "Right now" — with the
unit changing honestly with it ("people located" vs "connections located"). The
choice is remembered per reader. Asking for the window map before anything was
recorded falls back to live and says why rather than drawing an empty country.

THE NOTICE RETIRES ITSELF. A banner someone must remember to delete would still
be there over a mature figure years into a Pacifica rollout, teaching managers
to distrust the number. `geoCoverage()` derives it: "still filling in" while the
record is shorter than the window or any device in it predates the record, and
nothing once neither holds. Half a day of slack stops rounding flicker.

Verification, Node 24.20.0: full suite 688/688, zero failures (6.38 s). New
`test/device-geography.test.js` (11) covers the fold, the migration from a
hand-built pre-feature table, relay/withheld/non-US token rules, the
cross-channel MAX, and no-database. New `test/geo-coverage-notice.test.js` (6)
pins the three notice states and that the third is reached unaided. Two initial
failures there were my test's own bugs — geo.js reports a datacenter as network
'hosting', and the id helper prefixed 'dev' — not defects in the code.
`test/audience-refresh.test.js` caught a real design mistake: a document-wide
click listener for one panel. It is now bound to `#geo-panel`, which survives
`innerHTML` and is the right scope anyway.

Booted locally on a scratch data dir: clean start, no migration error. The
devices DB is created on the first listener-detail cycle, so there was nothing
to inspect on disk; the fresh-create path is covered by the store tests, which
read `place` back and would throw if the column were absent.

NOT VERIFIED: anything requiring a signed-in session, and the first real period
map — there is no recorded geography anywhere yet, so on deploy the panel will
correctly show "Location history is still being collected" and fall back to the
live view. The window map becomes real as data accumulates.

Files: `device-store.js`, `listener-detail.js`, `monitor.js`, `server.js`,
`public/listeners.js`, `public/listeners.html`, `public/listeners.css`,
`test/device-geography.test.js`, `test/geo-coverage-notice.test.js`,
`test/range-echo-scope.test.js`, `HANDOFF.md`.
Status: local and tested, NOT committed or deployed.

Next action: commit, push, confirm both checks, deploy, hard-reload the Audience
tab once. Then leave it to gather: the period map is only as old as the deploy.

---

## 2026-09-10 — "Where They Listen" was labelled with a range it does not obey

The uptime-tile fix shipped as `73a0f5b`; CI green and the deployed `app.js` is
byte-identical to local HEAD. The owner then asked why the geography numbers
looked so low: WPFW showed 72 located connections under a 7-day heading, beside
a 7-day peak of 1,060.

They are not low. They are CURRENT. `places` is derived from `mounts`, which
comes from `monitor.getListenerDetail()` — the live Icecast snapshot — and never
reads `days`. 72 located + 5 relays excluded = 77, against a live count of 91
sampled minutes later. The panel reads this instant while "Range for everything
below" claims a week over it.

This cannot be fixed by windowing the map. `device-store.js` stores no region or
country field at all, so no geographic history exists to query; Icecast reports
where its current listeners are and keeps none of it. Live-only is a property of
the data, not a defect.

The defect was the label. `syncRangeEcho()` already skipped titles carrying
`data-live-section`, but the attribute appeared NOWHERE in any markup — the
guard had never once run, so every section below the selector was stamped,
including the one that ignores it. `listeners.html` now marks the section and
its help text says the panel reads this moment and why there is no 30-day map;
the geo hint reads "connected right now · read <time>" instead of only the read
time. No API, query or stored data changed — this is labelling.

Verification, Node 24.20.0: full suite 671/671, zero failures (6.37 s). New
`test/range-echo-scope.test.js` asserts every live-only section is marked, that
exactly the expected count is marked, that `syncRangeEcho` chips a governed
section and skips a marked one, and that the geo hint names its clock. Checked
against pre-fix code: tests 1-2 fail on the old HTML and test 4 on the old JS.
Test 4 was initially a false positive — "connected right now" already appears in
the deep-tile note, so a whole-file match passed unpatched; it is now scoped to
`renderGeo`. Test 3 passes either way by design: the mechanism always worked,
nothing was wired to it.

Files: `public/listeners.html`, `public/listeners.js`,
`test/range-echo-scope.test.js`, `HANDOFF.md`.
Status: local and tested, NOT committed or deployed.

Next action: commit, push, confirm both checks, deploy, then hard-reload the
Audience tab once — an open tab keeps the old script, which is what caused the
two earlier "it needed a refresh" reports.

---

## 2026-09-10 — History fix confirmed live; dashboard uptime tile fixed; audit

The History selection fix shipped as `e5d2aa9`. Verified rather than assumed:
both GitHub checks pass on that commit ("Unit tests", "Image builds and boots"),
and the deployed `history.js` and `listeners.js` are byte-identical to local
HEAD (SHA-256 `04f3200b…16fa7ac` and `5402b920…1ef4f452`). The earlier entry
below saying this was "not committed, pushed or deployed" is superseded.

SWEEP FOR THE CLASS, not the instance. The defect is: an async handler decides
what to paint by reading the MUTABLE current selection after its await, rather
than the selection captured when the request was issued. Every client script was
checked. `event-detail.js`, `geo-map.js`, `guide.js`, `audience-stats.js` and
`preview-player.js` make no network calls at all; `admin.js` is user-initiated
CRUD behind a timeout helper, not selection-scoped. That leaves three files:
`history.js` (correct — one captured query, one `Promise.all`, atomic commit,
version checked in BOTH the success and catch paths) and `listeners.js`
(correct — `loadVersion` checked after every await), plus one live instance.

`public/app.js` `refreshUptimeTile()` guarded its success path with
`uptimeFetchToken` but not its failure path. A slow 7-day request that failed
after the reader clicked 24h read the mutated `uptimeRangeDays`, saw `=== 1`,
and painted the local sample-based fallback over the live 24-hour figure — under
a "last 7 days" label, since `rangeLabel` was captured from the older range. The
same mutable read made `res.coverageDays < uptimeRangeDays * 0.95` judge a
30-day answer against 1 day, reporting partial coverage as complete. The range
is now captured once as `requestedDays`, and the catch returns when superseded.

Verification, Node 24.20.0: full suite 667/667 passing, zero failures
(6.35 s). New `test/uptime-range-refresh.test.js` drives the real loader in a
`vm` with controlled completion order; 2 of its 5 tests fail against unpatched
`app.js` and all 5 pass against the fix.

AUDIT, read-only against production. Per-station figures sum EXACTLY to All
stations at every range (24h 14,254; 7d 107,221; 30d 221,561), the five stations
partition the 10 streams with no orphan or overlap, and no longer range reports a
lower peak than a shorter one. Cache headers are correct on every HTML and JS
asset (`no-cache, no-store, must-revalidate`), so the hard refresh the owner
needed was a tab held open across a deploy, not a misconfiguration — no header
can fix that, only a build-stamp "reload" nudge, which is deferred as a feature.
`/api/listener-detail` reads the monitor's cached snapshot, so auditing it does
not probe Icecast or inflate listener counts. Stream `wbai-wpfw` ("WPFW
Eckington 1", 2.1 avg listeners) sits under station `wbai`; the owner confirms
this is a known arrangement — one station carries another's mount. No action.

NOT DONE: the protected `/api/listener-detail` audit. It needs a signed-in
session and this environment has no browser automation (no Puppeteer/Playwright)
and no `gh`. Asked the owner for the `kpft_admin` cookie value rather than a
password; the Player/App panel is unverified against real authenticated data.

Files: `public/app.js`, `test/uptime-range-refresh.test.js`, `HANDOFF.md`.
Status: fix is local and tested, NOT committed or deployed.

Next action: commit and push `public/app.js` + its test, confirm both checks,
deploy in Coolify. Then run the protected-endpoint audit once a session cookie
is available.

---

## 2026-09-10 — History selection race fixed locally

The owner confirmed that the earlier Audience deployment works after a hard
refresh, then requested a History/Audience audit. During that audit the separate
Incident History page reproduced the originally described class of failure.
The owner explicitly prioritized fixing it. ALL six station choices remain:
All stations, KPFT, WPFW, KPFK, WBAI and KPFA.

Verified failure before the patch: with a KPFK stats response delayed 1.5 seconds
only inside an isolated browser tab, choosing KPFK then KPFT left a KPFT heading,
KPFK incident streams, and KPFT audience streams. History used mutable station
scope across two batches of requests and had no stale-response guard. A full
page refresh hid the bug by issuing requests for only the initial selection.

`public/history.js` now captures one station/range query for all five requests,
fetches them together, and commits the complete response set only if it is still
the newest selection. Late fetches, JSON bodies, and failures are ignored.
`history.html` and `history.css` provide a loading/error status: prior figures are
concealed while station/range controls remain usable, export is disabled, and a
failed required request offers Retry. Supplementary endpoint failures still
allow current incident data to render. Production APIs/data are unchanged.

Verification, Node 24.20.0:
- `node --test test/*.test.js`: 662 passed, zero failures/skips, 6.40 seconds.
- Six new tests in `test/history-refresh.test.js`: query capture, atomic state,
  old KPFK/new KPFT ordering, late JSON/failures, loading/error/retry, optional
  endpoint failure, and All stations/All time behavior.
- Real Chromium with locally patched HTML/JS/CSS and real public production API
  responses: the delayed KPFK sequence now keeps KPFT incident and audience
  streams together. All stations shows 10 channels; KPFT 3, WPFW 1, KPFK 1,
  WBAI 3, KPFA 2. Each selected station's incident/audience stream IDs match.
- Browser checks passed for a 7-day range change, forced HTTP 500 hiding old
  figures and disabling export, and Retry restoring current KPFK data. No page
  errors. Fault injection occurred only in the isolated tab.
- JS syntax and `git diff --check` passed. Browser harness:
  `/private/tmp/history-fix/all-choices.cjs` (temporary local artifact).

Status: local implementation verified; not committed, pushed or deployed.
No production configuration, data, mail or service state was changed. The broader
signed-in Audience audit is not complete: audit automation did not find an
authenticated browser context, so its protected-data checks were not run. Do not
claim signed-in verification from the public History tests. Resume that audit
after the priority fix is released and browser sign-in is verified.

Files: `public/history.js`, `public/history.html`, `public/history.css`,
`test/history-refresh.test.js`, `README.md`, `HANDOFF.md`, `docs/PHASE-PLAN.md`,
`docs/DEVLOG.md`. Earlier documentation edits in this working tree are preserved.

Next action: commit/push this fix, confirm both CI jobs pass, manually deploy in
Coolify, and reload existing History tabs once to get the new JavaScript; then
verify All stations and individual selections live without further reloads.

---

## 2026-09-10 — Live dropdown follow-up (02:13 UTC on September 11)

Owner reports deploying and still seeing different numbers after station choice
versus refresh. Do not consider signed-in acceptance complete.

Verified public origin `https://kpft-icecast.supersoul.top`: the deployed
`listeners.js?v=dev` SHA-256 matches local HEAD `f81a407` exactly
(`5402b920a79b562aa52fcb25b840141a320a29da42a0c9aac38eafe41ef4f452`).
The response sends `Cache-Control: no-cache, no-store, must-revalidate`.
This proves what a new request receives, not which script an existing tab runs.

Fresh headless Chromium against the live HTML/JS sent both audience requests
with `stationId=kpfk` immediately on dropdown change from KPFT. No page errors.
KPFK 24-hour and 7-day totals matched on reload (1,612 and 10,447); the 30-day
rolling total moved by one (21,373 to 21,374), and a comparison percentage also
changed. Reads were at different times; this is not evidence that every numeric
change is a station-scoping defect. The protected detail API was not tested with
real authenticated data: this session has no signed-in browser context.

An isolated browser interception of ONLY the protected API used synthetic
Player/App counts (4,552 for all / 2,101 for KPFK). Against the real deployed
HTML/JS, the complete protected panel text matched exactly after selection and
reload for both KPFK and All stations, with no page errors. This tests rendering
and request routing, not the real protected API values. Temporary harnesses:
`/private/tmp/audience-live-check.cjs`, `/private/tmp/audience-panel-check.cjs`.
No application code, configuration, production data, or deployment was changed.

Next action: establish whether the owner reloaded the pre-deployment tab before
testing; if it persists in a fresh tab, obtain current signed-in before/after
values with the same station and range, and inspect the protected responses.
The reused screenshots are the earlier 19:38/19:39 captures, not new evidence
of which script was running after deployment.

---

## 2026-09-10 — Fix date-sensitive CI tests

The owner pushed the audience refresh as `62691e8` and reported GitHub CI #111:
Unit tests failed; Image builds and boots passed (screenshot). Coolify was not
deployed. GitHub CLI is not authenticated in this session, so remote job logs
were not retrieved; the screenshot establishes job status, not individual failures.

The six locally reproduced failures were caused by historical fixtures being
pruned during `store.load()` using the real wall clock. Queries passed a fixed
`NOW`, but loading did not. `test/counts-comparability.test.js` now freezes Date
at its existing 2026-09-01 fixture time; `test/mount-collision-repair.test.js`
freezes it 30 minutes after the historical repair cutoff. Each file resets the
mock after its tests. All existing assertions remain; production retention,
comparison calculations, repair logic, and the CI workflow are unchanged.

Verification: Node 24.20.0, both affected files 12/12 passing; complete suite
656/656 passing, zero failures/skips (6.43 seconds). `git diff --check` passed.
This resolves all six previously recorded baseline failures. The full run needed
local networking permission for the existing HTTP-server tests. Docker was not
rerun locally because only tests/docs changed; the owner's screenshot shows the
image job passed for `62691e8`.

Files: `test/counts-comparability.test.js`,
`test/mount-collision-repair.test.js`, `HANDOFF.md`, `docs/PHASE-PLAN.md`,
`docs/DEVLOG.md`. README behavior/setup is unchanged.

Next action: commit and push this test fix, wait for BOTH GitHub CI jobs to pass,
then perform the manual Coolify deploy and verify station/range switching in a
signed-in browser. This correction is local and has not been pushed or deployed.

---

## 2026-09-10 — Audience station selection refresh

Status: implemented locally; not deployed or verified in a real browser against production.

- Station and range changes now refresh both `/api/listeners` and
  `/api/listener-detail`. Player/App, platform, device totals, live sessions,
  per-mount numbers, distribution and geography follow the selection without
  reloading the page. The selected range is preserved when changing station.
- Previous figures clear while loading. A generation check after both fetch and
  JSON decoding prevents late responses or failures from replacing newer data.
  Empty results clear listening-hours content and its timezone hint as well.
- The detail API filters live mounts by station using host plus mount path,
  including bitrate variants. Unknown stations return no mounts; All stations
  retains its existing full-collection behavior. No collection or stored history
  is changed. Historical device mix remains visible when no listeners are active.
- Distinct addresses uses the exact per-mount value for a single selected mount.
  A deduplicated union is not stored for an arbitrary multi-mount selection, so
  that value is explicitly unavailable rather than showing a server-wide number
  or summing overlapping addresses. All stations retains the existing union.

Verification (Node 24.20.0): six behavioral regressions in
`test/audience-refresh.test.js` pass using the real page script in a mocked DOM
and the real route handler with fixture aggregates. Coverage includes KPFK and
All stations, range retention, out-of-order fetch and JSON responses, late
failures, signed-out/empty states, inactive stations with period data, and
host/path collisions. Syntax checks for both changed JS files and
`git diff --check` pass. The full suite run with the initial four new cases
reported 648 passed / 654 total / 6 failed / 0 skipped. The two additional
regressions pass in the six-case targeted run. All six full-suite failures
reproduce on a clean HEAD archive: three in `counts-comparability.test.js` and
three in `mount-collision-repair.test.js`. An initial sandboxed run also blocked
local HTTP test servers; rerunning with local networking removed those errors.
No live service, production data, deployment or email action was performed.

Files: `public/listeners.js`, `server.js`, `test/audience-refresh.test.js`,
`README.md`, `HANDOFF.md`, `docs/PHASE-PLAN.md`, `docs/DEVLOG.md`.

Next action: review and release this local fix through the existing manual
Coolify deployment flow, then verify KPFK → All stations → another station and
rapid station/range changes in a signed-in browser. Investigate the six baseline
suite failures separately; they are not introduced by this patch.

---

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
