# ── Build Stage ──────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Production Stage ─────────────────────────────────
FROM node:20-alpine

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
COPY scripts/ ./scripts/
COPY seed/ ./seed/
COPY public/ ./public/

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
