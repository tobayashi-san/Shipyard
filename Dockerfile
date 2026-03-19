# ── Stage 1: Build frontend ───────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────
# node:20-slim (Debian) is required — better-sqlite3 is a native addon
# that needs glibc (fcntl64). Alpine's musl libc is incompatible.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ansible openssh-client openssl gosu \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated non-root user for runtime
RUN groupadd -r -g 1001 shipyard && useradd -r -u 1001 -g shipyard -d /app shipyard

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

VOLUME ["/app/server/data"]
EXPOSE 443
ENV NODE_ENV=production

# Entrypoint runs as root to fix data-volume ownership, then drops to shipyard
ENTRYPOINT ["./docker-entrypoint.sh"]
