# ── Stage 1: Build frontend ───────────────────────────────────
# Keep the Node release explicit so builds do not silently move to a different
# runtime. Update this value through the normal dependency-update process.
FROM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868 AS builder
WORKDIR /app
COPY frontend-next/package*.json ./frontend-next/
RUN cd frontend-next && npm ci
COPY frontend-next/ ./frontend-next/
RUN cd frontend-next && npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────
# Use Debian for the runtime and native SQLite addon; both stages use Node 24.
FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae

RUN apt-get update && apt-get install -y --no-install-recommends \
      ansible openssh-client openssl gosu curl unzip git build-essential util-linux \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated non-root user for runtime
RUN groupadd -r -g 1001 shipyard && useradd -r -u 1001 -g shipyard -d /app shipyard

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev \
    && apt-get purge -y --auto-remove build-essential
COPY server/ ./server/
COPY --from=builder /app/frontend-next/dist ./frontend-next/dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN mkdir -p /app/.ansible/tmp && chown -R shipyard:shipyard /app/.ansible
RUN mkdir -p /app/server/playbooks && chown -R shipyard:shipyard /app/server/playbooks
RUN mkdir -p /app/bundled-playbooks && cp -a /app/server/playbooks/. /app/bundled-playbooks/ && chown -R shipyard:shipyard /app/bundled-playbooks
RUN mkdir -p /app/plugins && chown -R shipyard:shipyard /app/plugins

VOLUME ["/app/server/data"]
EXPOSE 8443
ENV NODE_ENV=production
ENV PORT=8443
ENV TZ=Europe/Zurich

# Entrypoint runs as root to fix data-volume ownership, then drops to shipyard
ENTRYPOINT ["./docker-entrypoint.sh"]
