# ── Build Stage ──────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Geo Database Stage ───────────────────────────────
# DB-IP ASN Lite, fetched at BUILD time and baked into the image.
#
# WHY IN THE IMAGE AND NOT ON THE VOLUME. A managed panel (Coolify, Dokku,
# Portainer) gives an operator a deploy button and no shell — no docker CLI, no
# way to copy a 9 MB binary into a named volume. The image is the only route the
# person deploying this actually has.
#
# WHY THIS IS ALLOWED. Baking a database into an image is redistribution. DB-IP
# Lite is CC BY 4.0, which permits it provided the credit is displayed — and the
# app renders that credit from the file it loaded, wherever the data is shown.
# MaxMind's GeoLite2 EULA restricts redistributing the database, so GeoLite2
# must NOT be baked in this way: a GeoLite2 deployment supplies its own file and
# points GEOIP_ASN_DB at it, overriding the default set below.
#
# THIS STAGE NEVER FAILS THE BUILD. A monitor that stops shipping because a
# database mirror had a bad minute has traded a working product for an optional
# feature. On failure the directory is simply empty, geo.js reports the file as
# missing, and the proxied share degrades to its user-agent floor — visibly, on
# the page, saying which signal is absent.
#
# Build with --build-arg SKIP_GEODB=1 to opt out entirely.
FROM alpine:3.20 AS geodb
ARG SKIP_GEODB=0
RUN apk add --no-cache curl
WORKDIR /geo
COPY scripts/fetch-geodb.sh /tmp/fetch-geodb.sh
RUN if [ "$SKIP_GEODB" = "1" ]; then \
      echo "[geodb] skipped: SKIP_GEODB=1"; \
    else \
      sh /tmp/fetch-geodb.sh /geo/dbip-asn.mmdb \
        || echo "[geodb] NOT INSTALLED — the image will run without it"; \
    fi

# ── Production Stage ─────────────────────────────────
FROM node:24-alpine

LABEL org.opencontainers.image.title="Pacifica Stream Monitor"
LABEL org.opencontainers.image.description="Real-time Icecast stream uptime monitor with email alerts"

WORKDIR /app

# Non-root user, plus curl for the HEALTHCHECK below. Nothing here is specific
# to any hosting platform.
RUN addgroup -S monitor && adduser -S monitor -G monitor && \
    apk add --no-cache curl

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application
COPY package.json ./
COPY server.js ./
COPY monitor.js ./
COPY diagnose.js ./
COPY store.js ./
COPY auth.js ./
COPY redact.js ./
COPY safe-url.js ./
COPY discover.js ./
COPY listener-detail.js ./
COPY geo.js ./
COPY device-store.js ./
COPY scripts/ ./scripts/
COPY seed/ ./seed/
COPY public/ ./public/

# The geo database, if the stage above managed to fetch one. An empty directory
# here is a valid outcome, not a broken build.
COPY --from=geodb /geo/ ./geo/

# The DEFAULT location, so a deployment gets relay detection with no panel
# configuration at all. Override it to use your own file — a GeoLite2 database
# on the persistent volume, say — or set it empty to disable the lookup.
ENV GEOIP_ASN_DB=/app/geo/dbip-asn.mmdb

# Marks this as a deployed instance, which is what permits email alerts to the
# station's real recipient list. A developer running `node server.js` from a
# checkout does not have it, and their alerts are suppressed — see
# isDeployedInstance() in monitor.js. Without this a shared .env means a laptop
# mails the station's General Manager.
ENV MONITOR_CONTAINER=1

# Create data directory
RUN mkdir -p /app/data && chown -R monitor:monitor /app

# Incident history lives here and is retained permanently — this MUST be backed
# by a persistent volume, or every redeploy starts the record over from zero.
VOLUME ["/app/data"]

USER monitor

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
