# ── Stage 1: Build frontend ───────────────────────────────────
# Keep the Node release explicit so builds do not silently move to a different
# runtime. Update this value through the normal dependency-update process.
# The frontend bundle is architecture-independent, so it always builds natively.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder
WORKDIR /app
COPY frontend-next/package*.json ./frontend-next/
RUN cd frontend-next && npm ci
COPY frontend-next/ ./frontend-next/
RUN cd frontend-next && npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────
# Use Debian for the runtime and native SQLite addon; both stages use Node 24.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# Apply Debian security updates published after the pinned base image.
# Packages are fetched over HTTPS so builds also work where outbound HTTP is
# blocked. The slim image has no CA bundle yet; borrow the builder's for apt.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /tmp/build-ca.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && echo 'Acquire::https::CaInfo "/tmp/build-ca.crt";' > /etc/apt/apt.conf.d/99build-ca \
    && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
      ansible openssh-client openssl gosu curl unzip git build-essential util-linux rclone \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99build-ca /tmp/build-ca.crt

# Create a dedicated non-root user for runtime
RUN groupadd -r -g 1001 fleet && useradd -r -u 1001 -g fleet -d /app fleet

WORKDIR /app
COPY server/package*.json ./server/
# npm is only needed to install dependencies; removing it keeps its bundled
# packages out of the runtime image and its vulnerability surface.
RUN cd server && npm ci --omit=dev \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm
COPY server/ ./server/
COPY --from=builder /app/frontend-next/dist ./frontend-next/dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN mkdir -p /app/.ansible/tmp && chown -R fleet:fleet /app/.ansible
RUN mkdir -p /app/server/playbooks && chown -R fleet:fleet /app/server/playbooks
RUN mkdir -p /app/bundled-playbooks && cp -a /app/server/playbooks/. /app/bundled-playbooks/ && chown -R fleet:fleet /app/bundled-playbooks

VOLUME ["/app/server/data"]
EXPOSE 8443
ENV NODE_ENV=production
ENV PORT=8443
ENV TZ=Europe/Zurich

# Entrypoint runs as root to fix data-volume ownership, then drops to fleet
ENTRYPOINT ["./docker-entrypoint.sh"]
