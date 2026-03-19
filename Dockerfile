# ── Stage 1: Build frontend ───────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────
FROM node:20-alpine
RUN apk add --no-cache ansible openssh-client openssl

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

ENTRYPOINT ["./docker-entrypoint.sh"]
