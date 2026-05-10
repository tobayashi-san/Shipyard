# Installation

## Requirements

- **Docker** 20.10+ with Docker Compose v2
- A host with at least **512 MB RAM** and **1 GB disk space**
- Network access to the servers you want to manage (SSH, usually port 22)

## Quick Start

```bash
mkdir shipyard && cd shipyard

# Generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "SHIPYARD_KEY_SECRET=$(openssl rand -hex 32)" >> .env

# Create docker-compose.yml
cat > docker-compose.yml << 'EOF'
services:
  shipyard:
    # "latest" points to stable releases only (no RC tags)
    image: ghcr.io/tobayashi-san/shipyard:latest
    container_name: shipyard
    restart: unless-stopped
    ports:
      - "443:443"
    volumes:
      - shipyard-data:/app/server/data
      - ./playbooks:/app/server/playbooks
      - ./plugins:/app/plugins
      # OpenTofu workspaces (optional bind mount):
      # - /path/to/workspaces:/workspaces
      # Custom TLS certificate (optional):
      # - /etc/ssl/certs/shipyard.crt:/certs/shipyard.crt:ro
      # - /etc/ssl/private/shipyard.key:/certs/shipyard.key:ro
    environment:
      - NODE_ENV=production
      - TZ=${TZ:-Europe/Zurich}
      - SHIPYARD_TIMEZONE=${SHIPYARD_TIMEZONE:-Europe/Zurich}
      - JWT_SECRET=${JWT_SECRET:?Create a .env file with JWT_SECRET}
      - SHIPYARD_KEY_SECRET=${SHIPYARD_KEY_SECRET:?Create a .env file with SHIPYARD_KEY_SECRET}
      # - PORT=443
      # - ALLOWED_ORIGINS=https://shipyard.example.com
      # - SSL_CERT=/certs/shipyard.crt
      # - SSL_KEY=/certs/shipyard.key
      # Set to 1 when running behind a reverse proxy that sends X-Forwarded-* headers
      # - TRUST_PROXY=1
      # Extra SANs for the self-signed TLS certificate (useful for agent push mode)
      # - CERT_SANS=IP:10.30.1.10,DNS:shipyard.example.com
    healthcheck:
      test: ["CMD", "node", "-e", "require('https').get({hostname:'localhost',path:'/api/health',rejectUnauthorized:false}, r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

volumes:
  shipyard-data:
EOF

docker compose up -d
```

Open `https://your-host` in your browser. The setup wizard appears only when no users exist and guides you through account creation, appearance settings, and SSH key generation.

## Volumes

| Mount Point | Purpose | Required |
|-------------|---------|----------|
| `/app/server/data` | SQLite database, generated certificates, SSH keys, cache, internal state | **Yes** |
| `/app/server/playbooks` | User-visible Ansible playbook YAML files | **Yes** |
| `/app/plugins` | Runtime plugin directory | Recommended |
| `/workspaces` | OpenTofu/Terraform workspaces if using the OpenTofu plugin | Optional |

Back up `/app/server/data` regularly. It contains the database and encrypted secrets.

## TLS

Shipyard auto-generates a self-signed certificate on first start when `SSL_CERT` and `SSL_KEY` are not set.

For agent push/auto mode, managed servers must be able to verify the certificate. Set `CERT_SANS` to the LAN IP or DNS name used by managed servers:

```yaml
environment:
  - CERT_SANS=IP:10.30.1.10,DNS:shipyard.example.com
```

To use your own certificate:

```yaml
environment:
  - SSL_CERT=/certs/fullchain.pem
  - SSL_KEY=/certs/privkey.pem
volumes:
  - /etc/letsencrypt/live/your-domain/fullchain.pem:/certs/fullchain.pem:ro
  - /etc/letsencrypt/live/your-domain/privkey.pem:/certs/privkey.pem:ro
```

## Reverse Proxy

If running behind a reverse proxy, set `ALLOWED_ORIGINS` to the public URL and enable `TRUST_PROXY`:

```yaml
environment:
  - ALLOWED_ORIGINS=https://shipyard.example.com
  - TRUST_PROXY=1
```

`TRUST_PROXY=1` is required behind trusted reverse proxies that send `X-Forwarded-*` headers, so IP-based rate limits and client IP handling work correctly.

## HTTP Mode (Not Recommended)

If TLS is terminated by a reverse proxy, you can run Shipyard over HTTP internally by omitting `SSL_CERT` and `SSL_KEY` and mapping port `3001`:

```yaml
ports:
  - "3001:3001"
```

Agent push/auto mode requires HTTPS for agent communication.

## Updating

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically on startup.

### Stable vs RC Tags

- `ghcr.io/tobayashi-san/shipyard:latest` = latest stable release only
- `ghcr.io/tobayashi-san/shipyard:1.0.1-rc.1` = explicit release candidate example
- RC tags do not move `latest`

## Building from Source

```bash
git clone https://github.com/tobayashi-san/Shipyard.git
cd Shipyard

# Frontend
cd frontend-next && npm install && npm run build && cd ..

# Backend
cd server && npm install && cd ..

# Start
cd server && NODE_ENV=production node index.js
```

Requirements for source builds: Node.js 20+, Ansible, openssh-client, Python 3.

Production serves the built React frontend from `frontend-next/dist` at the application root. The old `frontend/` Vite app has been removed.

## Local Demo Instance for Screenshots

If you need a local instance with populated dashboard data for screenshots or release material, run a separate demo container with its own SQLite volume.

Typical flow:

1. Build the local Docker image from the repository root.
2. Seed a separate demo database and mount it into the container.
3. Run the demo container on a different local port, for example `8444`.

This keeps normal Shipyard data untouched while providing repeatable screenshots.
