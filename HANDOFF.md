# Handoff — Icecast Monitor

> **Purpose.** Everything a new session, a new developer, or another model needs
> to pick this up without reading the conversation it came from. Written
> 2026-08-27, current as of commit `91114be`.
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
npm test                                   # 168 tests, all should pass
curl -s https://kpft-icecast.supersoul.top/api/stations | jq   # what it monitors
curl -s https://kpft-icecast.supersoul.top/api/status   | jq   # how it is doing
```

**Read, in this order.** §1 (the one idea), §3 (the data flow), §8 (the traps).
Those three are what stop you breaking something quietly. Everything else can be
read when you need it.

**The five things most likely to catch you out**, all of which fail *silently*:

| | |
|---|---|
| Alerting on probe failure | Reintroducing it undoes the product. §1 |
| A new aggregate that isn't station-scoped | Reports one station's outages as another's. §8 |
| Renaming a channel id | Orphans its history rather than moving it. §8 |
| Adding a module without updating the Dockerfile | Container dies on startup. CI catches it |
| Assuming a push deployed | Deploys are manual, always |

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

- **Live and healthy.** 3 stations (KPFT Houston, WPFW Washington DC, KPFK Los
  Angeles), 5 channels, 1 Icecast host, ~456 events retained since 2026-08-04.
- **All three stations share one Icecast host**, which is the whole affiliate
  economics: one snapshot fetch per cycle serves all of them.
- **168 tests**, `npm test`, Node's built-in runner, no test framework dependency.
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
   reported 57 of 88 listeners — a third of the audience invisible. Probing still
   uses one mount per channel, so one problem produces one alert, not three.

3. **Stream ids are load-bearing.** Every sample, rollup and event is keyed by
   them. `kpft-main`, `kpft-hd2`, `kpft-hd3` must not change or history detaches
   silently — the data does not disappear, it just stops being found.

4. **Hosts are a global pool, not a property of a station.** Five Pacifica
   stations share one Icecast server; ~28 affiliates share another. One snapshot
   fetch per *host* serves every station on it. A host-per-station model would
   refetch the same server 33 times a minute.

5. **Audience figures are frozen at recovery, not computed later.** Icecast only
   reports listeners while the mount exists, and raw samples compact after 7
   days. `getAudienceContext()` captures the pre-failure count at resolution time
   and writes it onto the event. Recomputing later is not possible.

---

## 4. Files

| File | Lines | What it owns |
|---|---|---|
| `store.js` | 1870 | Persistence, retention, audience model, rollups, **station config** |
| `monitor.js` | 1827 | Check cycle, episode state, email composition, weekly roundup |
| `diagnose.js` | 987 | Probe, Icecast snapshot, **the classifier and the alert gate** |
| `server.js` | 326 | HTTP API |
| `auth.js` | ~290 | Admin session gate: scrypt, signed cookie, rate limiting |
| `redact.js` | ~130 | **Public projections.** What anonymous callers may see |
| `safe-url.js` | ~150 | **SSRF guard** for fetching user-supplied URLs |
| `discover.js` | ~240 | Station discovery: mount → channel grouping, validation |
| `public/app.js` | 633 | Dashboard |
| `public/history.js` | 1515 | History page, station picker, charts |
| `public/admin.js` | 363 | Admin panel: add, edit, remove stations |
| `public/guide.js` | 230 | In-app guide (content lives here as data) |
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

## 6. Where it is going

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
7. ⬅ **NEXT: per-station alert recipients.** Alert emails are still one global
   list, so WPFW's GM would be paged about KPFT. This is the first genuinely
   GM-facing screen
8. Fleet view
9. Roles and multi-user — **only when a real GM asks for a login**

Two design rules already decided:

- **Two panels, not one.** "Add a station" (rare, technical, restricted) and "my
  station" (weekly, must be simple) are different jobs for different people.
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
- **Audience analytics does NOT go in the admin panel.** Admin configures the
  system — rare, technical, restricted. Reporting is frequent and GM-facing, and
  belongs on the history page and fleet view. Collapsing them puts "delete
  station" a tab away from a weekly report (§8b of the scope doc).
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

---

## 9. Verifying a change

```bash
npm test                                             # 168 tests
node --check server.js monitor.js store.js diagnose.js auth.js

# Against production
curl -s .../health
curl -s .../api/stations   | jq     # what it thinks it monitors
curl -s .../api/status     | jq     # per-channel state and variant counts
curl -s .../api/diagnostics| jq     # the Icecast inventory it can see
curl -s '.../api/stats?days=1' | jq .storage    # event count, oldest event
```

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
4. Do we have Icecast *admin* credentials for the Pacifica host? Unlocks
   per-listener geography and session data.
5. **Did the retry actually reduce alert noise?** 32% of events were `unknown`
   before it. Re-measure after a week of production data — around 2026-09-03 —
   rather than assuming.
