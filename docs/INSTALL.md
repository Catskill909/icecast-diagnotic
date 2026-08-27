# Installing the Icecast Monitor

The application is a plain Node.js service in a standard container. **It has no
dependency on any particular hosting platform** — Coolify, Docker Compose, a bare
Docker host, or Node running under systemd all work, and all run the same code.
They differ only in *where you type the environment variables*.

That portability is deliberate: a station that already runs its own server should
not have to adopt someone else's hosting stack to monitor its own streams.

---

## 1. Choose a path

| Path | Good for | Effort |
|---|---|---|
| **[Docker Compose](#docker-compose)** | Most stations. One file, one command | Lowest |
| **[Coolify / Dokku / Portainer](#coolify-and-other-panels)** | Teams already running a panel | Low |
| **[Plain `docker run`](#plain-docker)** | A server with Docker and nothing else | Low |
| **[Bare Node](#bare-node)** | No Docker; existing Node host | Medium |

All four need the same two things: **a set of environment variables** and **a
persistent directory for the data**.

---

## 2. The two things that actually matter

### Persistence

The permanent incident record lives in `/app/data`. **It must be on a persistent
volume.**

Without one, every redeploy silently starts the history over at zero — and the
failure is quiet in the worst way, because uptime computed from an empty record
looks *perfect*. A monitor reporting 100% uptime because it has amnesia is worse
than no monitor.

To verify persistence after a deploy, note `oldestEvent` from `/api/stats` before
and after. Comparing counts alone proves nothing when the count is zero: zero
survives everything.

### Configuration

Configuration is split, on purpose:

| Lives in the environment | Lives in the data volume |
|---|---|
| SMTP credentials | Which stations and channels are monitored |
| `SESSION_SECRET` | Mount lists |
| `ADMIN_USER`, `ADMIN_PASSWORD_HASH` | *(later: alert recipients, thresholds)* |
| Timezone, intervals, thresholds | |

**Environment variables seed the station configuration on first boot, then the
store owns it.** After that, editing `STREAMS` in a hosting panel does nothing —
which is what allows an admin UI to change settings without a redeploy. Set
`CONFIG_RESEED=true` and restart to overwrite a bad seed; wiping the volume would
also destroy the incident history.

Secrets stay in the environment, where they never need a UI and so never
conflict with the stored settings.

---

## 3. Docker Compose

The recommended path for a station running its own server.

```bash
git clone https://github.com/Catskill909/icecast-diagnotic.git
cd icecast-diagnotic
cp .env.example .env
$EDITOR .env                 # see section 5
docker compose up -d
```

Then open `http://your-server:3000`.

To keep the data somewhere you can see and back up, swap the named volume in
`docker-compose.yml` for a bind mount:

```yaml
volumes:
  - ./data:/app/data
```

Updating:

```bash
git pull && docker compose up -d --build
```

---

## 4. Coolify and other panels

Coolify, Dokku, Portainer and CapRover all build the same `Dockerfile`. The only
platform-specific steps are:

1. Point the resource at the Git repository.
2. Add a **persistent volume mounted at `/app/data`**.
3. Enter the environment variables in the panel rather than a `.env` file.

Nothing in the image is panel-specific. A deployment can move between panels, or
off them entirely, by carrying the data volume across.

> **Note for Coolify:** deploys are triggered from the dashboard. A `git push`
> alone does not ship anything unless a webhook is configured.

---

## 5. Plain Docker

```bash
docker build -t icecast-monitor .
docker volume create monitor-data

docker run -d --name icecast-monitor \
  --restart unless-stopped \
  -p 3000:3000 \
  -v monitor-data:/app/data \
  --env-file .env \
  icecast-monitor
```

---

## 6. Bare Node

No Docker required. Node 20 or newer.

```bash
git clone https://github.com/Catskill909/icecast-diagnotic.git
cd icecast-diagnotic
npm install --omit=dev
cp .env.example .env
$EDITOR .env
npm start
```

`DATA_DIR` defaults to `./data` here, which persists as long as the directory
does. For a long-running service, put it behind systemd:

```ini
# /etc/systemd/system/icecast-monitor.service
[Unit]
Description=Icecast Monitor
After=network.target

[Service]
Type=simple
User=monitor
WorkingDirectory=/opt/icecast-monitor
EnvironmentFile=/opt/icecast-monitor/.env
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

---

## 7. Minimum configuration

The smallest `.env` that runs a single-stream station:

```bash
# What to monitor
STREAMS=[{"id":"main","name":"WXYZ Main","url":"https://stream.example.org:8000/live"}]
ICECAST_STATUS_URL=https://stream.example.org:8000/status-json.xsl
STATION_NAME=WXYZ
STATION_TZ=America/New_York

# Where the record lives (containers: leave as /app/data)
DATA_DIR=/app/data
```

That is enough for uptime, dead-air detection and listener counts. Everything
below is optional.

### Adding email alerts

```bash
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_USER=monitor@example.org
SMTP_PASS=...
SMTP_FROM="WXYZ Stream Monitor <monitor@example.org>"
ALERT_EMAILS=engineer@example.org,gm@example.org
DASHBOARD_URL=https://monitor.example.org
```

Alerts are gated on **listener impact**, not probe failure — see
[`DIAGNOSTICS.md`](DIAGNOSTICS.md). A station that would rather be told about
everything can set `ALERT_ON_HARMLESS_OUTAGE=true`, though the production data
that motivated the gate argues against it.

### Adding admin login

Required before any endpoint that sends mail will work: `/api/test-alert` and
`/api/weekly-roundup` **fail closed** without it.

```bash
node scripts/hash-password.js       # prints ADMIN_PASSWORD_HASH=...
```

```bash
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=scrypt:...
SESSION_SECRET=...                  # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Sign in at `/login.html`.

### Channels with multiple bitrates

Icecast publishes each bitrate variant as its own mount. List them so listener
counts cover the whole channel rather than one variant:

```json
STREAMS=[{"id":"main","name":"Main","url":"https://h:8000/live_128","mounts":["/live_128","/live_64"]}]
```

Omitting `mounts` is valid and counts only the probed URL — which is correct for
a station that genuinely has one stream, and an undercount for one that does not.

---

## 8. Verifying an install

```bash
curl -s localhost:3000/health                    # {"status":"ok",...}
curl -s localhost:3000/api/stations | jq         # what it thinks it is monitoring
curl -s localhost:3000/api/status | jq           # live per-channel state
curl -s localhost:3000/api/diagnostics | jq      # the Icecast inventory it can see
```

If `/api/diagnostics` reports `reachable: false`, the monitor cannot read the
Icecast status endpoint. Everything still runs, but listener counts are
unavailable and every failure is recorded as `unknown` impact — which alerts.
Check `ICECAST_STATUS_URL` first; not every host exposes `status-json.xsl`.
