# ── Build Stage ──────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Production Stage ─────────────────────────────────
FROM node:20-alpine

LABEL org.opencontainers.image.title="KPFT Icecast Monitor"
LABEL org.opencontainers.image.description="Real-time Icecast stream uptime monitor with email alerts"

WORKDIR /app

# Create non-root user and install curl for Coolify healthchecks
RUN addgroup -S monitor && adduser -S monitor -G monitor && \
    apk add --no-cache curl

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application
COPY package.json ./
COPY server.js ./
COPY monitor.js ./
COPY public/ ./public/

# Create data directory
RUN mkdir -p /app/data && chown -R monitor:monitor /app

USER monitor

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
