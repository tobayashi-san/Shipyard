# Installation

## Requirements

- **Docker** 20.10+ with Docker Compose v2.17+
- A host with at least **512 MB RAM** and **1 GB disk space**
- Network access to the servers you want to manage (SSH, usually port 22)

## Quick Start

```bash
git clone https://github.com/tobayashi-san/Shipyard.git
cd Shipyard
cp .env.example .env
chmod 600 .env
# Generate two different values and enter them as JWT_SECRET and
# SHIPYARD_KEY_SECRET in .env:
openssl rand -hex 32
openssl rand -hex 32
docker compose up -d --wait
```

The supplied Compose file binds to `https://localhost` by default. Set a
private-LAN address in `.env` only when access is protected by a firewall or
VPN. The setup wizard appears only when no users exist and guides you through
account creation, appearance settings, and SSH key generation.

For the full supported procedure—including TLS, reverse proxies, persistent
data, backups, updates, and Compose security settings—see the repository's
[Docker deployment guide](../../DOCKER_DEPLOYMENT.md).

## Volumes

| Mount Point | Purpose | Required |
|-------------|---------|----------|
| `/app/server/data` | SQLite database, generated certificates, SSH keys, cache, internal state | **Yes** |
| `/app/server/playbooks` | User-visible Ansible playbook YAML files | **Yes** |
| `/app/plugins` | Runtime plugin directory | Recommended |
| `/workspaces` | OpenTofu/Terraform deployment workspaces | Optional |

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
