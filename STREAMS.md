# Quick reference — URLs and stream addresses

> Everything needed to test, add a station, or reach the app. Kept here so it is
> never buried in a chat log.

## The app

| | |
|---|---|
| Dashboard | https://kpft-icecast.supersoul.top |
| **Admin panel** | https://kpft-icecast.supersoul.top/admin.html |
| History | https://kpft-icecast.supersoul.top/history.html |
| Audience | https://kpft-icecast.supersoul.top/listeners.html |
| Deploy (Coolify) | https://coolify.supersoul.top/ · resource `nsc8k4gg40okskkcw40ocsko` |
| Repo | https://github.com/Catskill909/icecast-diagnotic |

**Deploys are manual.** `git push` ships nothing until Deploy is clicked.

## Pacifica sister stations — paste any of these into "Add a station"

| Station | Stream URL |
|---|---|
| KPFT Houston | `https://streams.pacifica.org:9000/live_128` |
| KPFT HD2 | `https://streams.pacifica.org:9000/HD3_128` |
| KPFT HD3 | `https://streams.pacifica.org:9000/classic_country` |
| WPFW Washington DC | `https://streams.pacifica.org:9000/wpfw_128` |
| KPFK Los Angeles | `https://streams.pacifica.org:9000/kpfk_128` |
| WBAI New York | `https://streaming.wbai.org/wbai_verizon` |
| **KPFA Berkeley — own server** | `https://streams.kpfa.org:8443/kpfa` |
| KPFA — Pacifica relay | `https://streams.pacifica.org:9000/kpfa` |

**KPFA is one station on two servers.** Both rows above belong to station `kpfa`
as two separate channels — two dashboard cards, one line in the Audience
dropdown. Pasting either URL when the other is already monitored makes the panel
offer **"Add the ticked channel(s) to KPFA Berkeley"**; take that offer rather
than the demoted "Add as a separate station instead", or you get two stations
with the same name and a split audience.

**KPFA runs two:** its own Icecast (~250 listeners, the real audience) and a
relay on Pacifica's shared host (~12). Both are worth monitoring; they are
separate stations in the app because they are separate servers.

## WPFW is relayed on WBAI's server — and is currently filed under WBAI

`streaming.wbai.org` carries three mounts, and one of them is not WBAI's:

| Mount | Icecast name | Whose programme |
|---|---|---|
| `/wbai_verizon` | WBAI (Verizon) | WBAI |
| `/wbai_spectrum` | WBAI (Spectrum) | WBAI |
| `/wpfw_128` | **WPFW Washington** | **WPFW** — a relay, ~2 listeners |

**In the live config that third mount is a channel of station `wbai`**, named
"WPFW Eckington 1". So WBAI's audience totals include a couple of WPFW's
listeners, and a failure on that mount would alert WBAI's recipients about
WPFW's programme.

**It should belong to station `wpfw`**, whose audience it is: WPFW's real total
is its Pacifica origin plus this relay. Move it in the admin panel — edit the
WBAI station, remove the "WPFW Eckington 1" channel, then paste
`https://streaming.wbai.org/wpfw_128` and take the offer to add it to WPFW
Washington DC. (The one argument the other way: the *server* that would fail is
WBAI's, so WBAI's engineers may want the alert. Audience accounting and paging
disagree here; the audience is the reason the app exists.)

**How it got there, and why it cannot happen again.** Discovery classified it
correctly — different call sign, so it was listed under "other channels on this
server — other stations, most likely" — but the checkbox arrived *ticked*,
because the panel decided pre-ticking from `sharedHost` ("more than three
channels on this server") rather than from that classification. WBAI's host has
exactly three. `discover.summarise()` now returns `proposed` per channel and the
panel obeys it; see `test/discovery-proposal.test.js`.

## Icecast status endpoints — what the monitor reads

| Host | Status URL |
|---|---|
| Pacifica shared (5 stations) | https://streams.pacifica.org:9000/status-json.xsl |
| WBAI | https://streaming.wbai.org/status-json.xsl |
| KPFA | https://streams.kpfa.org/status-json.xsl |

Open any of these in a browser to see every mount, its listeners, and what is
playing right now.

## Checking the live app from a terminal

```bash
B=https://kpft-icecast.supersoul.top

curl -s $B/health                                  # is it up
curl -s $B/api/status        | jq                  # every channel, listeners, variants
curl -s "$B/api/stats?days=1" | jq .storage        # event count, oldest event
curl -s "$B/api/uptime?days=7" | jq                # audio vs probe uptime
curl -s $B/api/diagnostics   | jq .icecast         # what Icecast we can see
```

**After any deploy**, confirm the data volume survived:

```bash
curl -s "$B/api/stats?days=1" | jq -r .storage.oldestEvent
# must still be 2026-08-04T17:52:53.123Z
```

## Not yet monitored, on servers already polled

- **KPFB 89.3** — `/kpfb` on KPFA's server. Currently no source connected.
- `/pacifica_one` — a network feed on KPFA's server.

---

## Open questions for Pacifica — config reality vs. what is configured

Found by the monitor itself on 2026-09-02, from outside. **None of these are
bugs and none block anything** — they are things to settle when the tool is
actually put to use with Pacifica, at which point dormant mounts, ownership and
naming all get tightened together. Recorded here so they are not lost.

| # | What the app found | Question |
|---|---|---|
| 1 | `streaming.wbai.org/wpfw_128` carries **WPFW's audio** — identical ICY headers to Pacifica's copy, including genre "Jazz and Justice" and the same `icy-url: url` placeholder typo. It is filed here under **station WBAI**, so its ~3 listeners count as WBAI's. | Is this relay wanted? If so it belongs to **WPFW** (one station, two servers — the same shape as KPFA). |
| 2 | `streaming.wbai.org/wbai_spectrum` has **0 listeners** and has for as long as we have watched. | Live, or dormant and worth retiring? |
| 3 | `streaming.wbai.org` is **WBAI's own box** — AWS, `chris@wbai.org`, Icecast 2.4.4, up since 2025-06-15, `location` never set. Pacifica's is a different machine entirely. | Who maintains it, and is the WPFW relay on it deliberate? |
| 4 | Every KPFT and sister mount on Pacifica's server reports `source_ip 127.0.0.1` and `user_agent pontifistreamer 3.1.2` — a process on Pacifica's own host. **The Barix is not what connects to Icecast**; the chain is `Barix → pontifistreamer → Icecast`. | When a mount drops, which hop failed? The app can only see the last one, so its "check the encoder" wording names one of two hypotheses. |
| 5 | `/padma` on **Pacifica's** server is named "WBAI (Verizon)" — the mirror of #1. | Cross-relaying between stations is clearly normal; is there a map of which relay is authoritative for whom? |

**Why these are being left alone for now.** Attributing a stream to the wrong
station changes whose audience figures it lands in, so it is worth getting
right — but getting it right means knowing which relays Pacifica intends to
keep, and that is a conversation, not a code change. A guess made now would
have to be undone.

**The one code change these argue for**, when the time comes: the app already
reads a call sign from each mount's `server_name` and could warn *"this channel
identifies as WPFW — add it to WBAI anyway?"* at the moment a host is added.
That catches the class rather than correcting instances.
