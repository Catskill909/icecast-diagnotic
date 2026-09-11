# Development log


## 2026-09-11 — Audience build-out, migration, and the sign-in fixes

A long session. `AUDIENCE-ROADMAP.md` §4.5 closed entirely, export/import
shipped, and two reported faults turned out to be different bugs from the ones
first suspected.

**Audience, §4.5 complete.** Returning vs new listeners; the device and player
mix as a series; when each region listens; metro-level geography; session
length. Four of the five needed no new collection — the data was already in
`devices` and had never been queried that way. Only the daypart profile needed
storage, because the hour is compacted away after 48 hours and cannot be
recovered afterwards.

**Two sign-in faults, neither in the login.** The Audience page linked to
`/login.html` with no `next`, so signing in landed on the dashboard. And
"the login keeps forgetting me" was NOT a missing `SESSION_SECRET` — that was
set — but `SameSite=Strict`, which withholds the cookie on any navigation
arriving from off-site. Fixing it to `Lax` required moving two mail-sending
routes from GET to POST first: a crafted link would otherwise have carried a
signed-in admin's session into them.

**A correctness bug found while designing UX.** KPFA is carried on two servers
and only one is credentialed, so its individual-listener, geography and daypart
figures covered half the station and were presented as the whole. The page now
reports coverage per channel with the host named.

**Export and import.** One gzipped bundle carries configuration, events,
telemetry and the device database, with a UI in the admin panel. It is also the
backup this deployment did not have. Verified against the real production
export: 47,528 device rows, the database opens and answers, no secret rode
along.

**Three bugs the tests found before they shipped**, two of them in my own
design: a salt guard that refused a bundle with nothing to lose, an
"import into an empty volume" rule the app itself makes impossible, and
`DEVICE_HASH_SALT` missing from the env checklist — the single most important
variable to carry.

**"iOS app is not showing for KPFK."** It was, at tenth, on a list that drew
nine and dropped the rest silently. Four lists had the same slice. They now show
everything at or above 1%, name the remainder for why it is hidden, and expand
in place.

Verification, Node 24.20.0: 883 tests, zero failures. Seven commits, all
deployed. The hazards this data keeps producing — tier smearing, detail lost at
compaction, length-biased sampling, a gate sized for the wrong claim, and an
absent figure reading as zero — are tabulated at the top of `HANDOFF.md`, which
is the part worth reading before computing anything else over it.


## 2026-09-11 — Geography over a period, per-station in-market share, in-app help

Status: three commits deployed and verified live (`73a0f5b`, `8683177`,
`16557ba`); documentation and in-app guide updates are local and uncommitted.

Four defects and one feature, all arising from one reported symptom: figures on
the Audience and History pages that looked wrong to a reader.

- **Dashboard uptime tile** (`73a0f5b`). `refreshUptimeTile()` guarded its
  success path with `uptimeFetchToken` but not its failure path. A slow 7-day
  request that failed after the reader clicked 24h read the mutated
  `uptimeRangeDays`, saw `=== 1`, and painted the local fallback over the live
  24-hour figure under a "last 7 days" label. The same mutable read made the
  partial-coverage test judge a 30-day answer against 1 day. Range is now
  captured once as `requestedDays`. A sweep of every client script found this
  was the last instance: `history.js` and `listeners.js` were already correct,
  and the other five scripts make no network calls at all.
- **The range chip claimed a panel it does not govern.** `syncRangeEcho()`
  skipped titles marked `data-live-section`, but the attribute appeared in no
  markup, so the guard had never run and "Where They Listen" was stamped with a
  range it ignores.
- **Geography over a WINDOW** (`8683177`). Icecast reports where its current
  listeners are and keeps no history, so the map could only ever answer "right
  now" — 77 connections under a heading saying seven days, beside a 7-day peak
  of 1,060. `devices.place` now stores one token per device per bucket, produced
  by the same `classifyChannel`/`lookupPlace` calls the live panel makes. The
  fold carries it (without that the map works at 24h and empties at 30d), and
  ALTER TABLE migrates existing installs, whose untagged rows read as
  `unrecorded` rather than `unplaced`. `MAX(place)` so a device placed on any
  channel is placed. The panel now offers both maps behind a toggle, with the
  unit changing honestly between "people" and "connections".
- **The coverage notice contradicted itself.** Shipped reading "recorded for 7
  days of the last 7 days, so this map covers part of the period" — because
  `period.coveredFrom` (device recording, years old) was read as
  `places.coveredFrom` (location recording, hours old). The store now reports
  both, and the notice is driven by counts of listeners with and without a
  location rather than by date arithmetic. A count cannot contradict itself and
  reaches zero unaided, so the notice still retires without anyone deleting it.
- **In-market share was a deployment's figure, not a station's** (`16557ba`).
  `homeRegion()` read one `STATION_REGION` env var, so WPFW reported "In Texas
  0%". `region` is now a station property carried on the channel exactly as
  `timezone` is, validated against the 50 states plus DC, and editable in both
  admin forms. The env var survives only for single-station installs. A sweep
  confirmed timezone was already scoped this way; region was the only holdout.

Verification (Node 24.20.0): full suite 708/708, zero failures. 53 new tests
across six files. Each new file was run against pre-fix code to confirm it
fails: uptime 2/5, range chip 2/4, station region 7/11. Three failures during
development were bugs in the tests themselves, not the code — geo.js reports a
datacenter as network `hosting`, an id helper prefixed `dev`, and
`assert.deepStrictEqual` compares prototypes across a `vm` realm boundary.

Also: `test/guide-topics.test.js` is the first test of any kind over the in-app
guide, which is one large literal array with no build step — a stray quote or a
missing field failed silently in the browser with every test still passing.


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
