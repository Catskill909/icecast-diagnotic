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
