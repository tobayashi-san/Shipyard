# Installation

## Docker Compose

Create a working directory:

```bash
mkdir shipyard
cd shipyard
```

Create secrets:

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "SHIPYARD_KEY_SECRET=$(openssl rand -hex 32)" >> .env
```

Create `docker-compose.yml`:

```yaml
services:
  shipyard:
    image: ghcr.io/tobayashi-san/shipyard:latest
    container_name: shipyard
    restart: unless-stopped
    ports:
      - "443:443"
    volumes:
      - shipyard-data:/app/server/data
      - ./playbooks:/app/server/playbooks
      - ./plugins:/app/plugins
      # Optional OpenTofu workspaces:
      # - /path/to/workspaces:/workspaces
      # Optional custom TLS certificate:
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
      # - TRUST_PROXY=1
      # - CERT_SANS=IP:10.30.1.10,DNS:shipyard.example.com

volumes:
  shipyard-data:
```

Start Shipyard:

```bash
docker compose up -d
```

Open `https://<host-ip>`.

## TLS

The container generates a self-signed certificate when `SSL_CERT` and `SSL_KEY` are not set.

For agent push/auto mode, managed servers must be able to verify the certificate. Set `CERT_SANS` to the LAN IP or DNS name used by the managed servers:

```yaml
environment:
  - CERT_SANS=IP:10.30.1.10,DNS:shipyard.example.com
```

For custom certificates, mount the files and set:

```yaml
environment:
  - SSL_CERT=/certs/shipyard.crt
  - SSL_KEY=/certs/shipyard.key
```

## Updating

```bash
docker compose pull
docker compose up -d
```

If you use `latest`, this updates to the newest stable release. Release candidates require an explicit tag such as `1.0.1-rc.1`.
