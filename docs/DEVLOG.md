# Development log


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
