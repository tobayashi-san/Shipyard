# Shipyard

Web dashboard for managing Linux servers — SSH, system monitoring, OS updates, Docker, and Ansible playbooks in a single interface.

> **Do not expose Shipyard to the public internet.**
> It stores SSH private keys and has direct shell access to all managed servers.
> Run it inside a private network or VPN. See the [Security Guide](https://github.com/tobayashi-san/Shipyard/wiki/Security-Guide).

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
    image: ghcr.io/tobayashi-san/shipyard:latest
    container_name: shipyard
    restart: unless-stopped
    ports:
      - "443:443"
    volumes:
      - shipyard-data:/app/server/data
      - ./playbooks:/app/server/playbooks
      - ./plugins:/app/plugins
    environment:
      - NODE_ENV=production
      - JWT_SECRET=${JWT_SECRET:?Create a .env file with JWT_SECRET — see README}
      - SHIPYARD_KEY_SECRET=${SHIPYARD_KEY_SECRET:?Create a .env file with SHIPYARD_KEY_SECRET — see README}

volumes:
  shipyard-data:
EOF

docker compose up -d
```

Open **`https://<host-ip>`** in your browser. The setup wizard will guide you through account creation, appearance settings, and SSH key generation.

HTTPS is enabled by default with a self-signed certificate — accept the browser warning once, or [bring your own certificate](https://github.com/tobayashi-san/Shipyard/wiki/Installation#custom-tls-certificate).

## Screenshots

![Dashboard](docs/images/Dashboard.png)

<details>
<summary>More screenshots</summary>

![Server Detail](docs/images/Server-Detail.png)
![Docker](docs/images/Docker.png)
![Terminal](docs/images/Terminal.png)
![Playbooks](docs/images/Playbooks.png)

</details>

## Features

**Servers**
- Add, edit, delete servers with tags and service labels
- Organize servers into nested groups
- Bulk import and export (JSON or CSV)

**Monitoring**
- CPU, RAM, disk, uptime, load average — polled in the background
- Configurable polling intervals per metric (system info, OS updates, image updates, custom updates)
- Dashboard with health summary, resource alerts, and recent activity

**Updates**
- OS package updates via Ansible (`apt`, `dnf`, `pacman`, …) with live terminal output
- Custom Update Tasks — track anything outside the package manager: scripts, GitHub releases; shows current vs. latest version with badge
- Docker / Podman image update checks across all containers

**Docker & Compose**
- Container overview with status, logs, and restart
- Read and edit `docker-compose.yml` files directly from the browser
- Run `up`, `down`, and `pull` on Compose stacks

**Ansible**
- Create, edit, and run custom playbooks with a built-in YAML editor
- Automatic version history (up to 5 backups per playbook)
- Scheduler — run playbooks on a cron schedule
- Live terminal output streamed via WebSocket

**SSH Terminal**
- Browser-based terminal per server
- Resizable, ANSI-aware

**SSH Key Management**
- Auto-generate an Ed25519 key pair on first start
- Deploy the public key to servers directly from the UI (password-based bootstrap)
- Optional AES-256-GCM encryption of the private key at rest (`SHIPYARD_KEY_SECRET`)

**Notifications**
- Webhook support: Discord, Slack, or generic JSON
- SMTP email alerts
- Test button for both channels in Settings

**Auth & Security**
- Multi-user authentication with JWT sessions
- Role-based access control (RBAC) with custom roles and granular permissions
- Optional TOTP / 2FA per user
- Audit log of all significant actions
- Rate limiting on login and deploy endpoints
- HTTPS with HSTS, CSP, X-Frame-Options headers

**Plugins**
- Hot-reloadable plugin system — drop a directory into `/app/plugins/` and click Reload
- Plugins can add backend routes, a sidebar entry, and a full frontend UI
- Bundled: **OpenTofu** — manage OpenTofu / Terraform workspaces with live output

**UI**
- German and English, auto-detected from browser locale
- Light / Dark / Auto theme
- White-label: custom app name, tagline, accent color

## Documentation

Full documentation is available in the **[Wiki](https://github.com/tobayashi-san/Shipyard/wiki)**:

- [Installation](https://github.com/tobayashi-san/Shipyard/wiki/Installation) — Docker deployment, requirements, first-time setup
- [Configuration](https://github.com/tobayashi-san/Shipyard/wiki/Configuration) — Environment variables, app settings, notifications
- [Security Guide](https://github.com/tobayashi-san/Shipyard/wiki/Security-Guide) — Hardening, encryption at rest, TLS, RBAC
- [Server Management](https://github.com/tobayashi-san/Shipyard/wiki/Server-Management) — Adding servers, groups, SSH connectivity
- [Playbooks & Schedules](https://github.com/tobayashi-san/Shipyard/wiki/Playbooks-and-Schedules) — Ansible playbooks, cron schedules
- [Docker Management](https://github.com/tobayashi-san/Shipyard/wiki/Docker-Management) — Containers, Compose, image updates
- [Plugin System](https://github.com/tobayashi-san/Shipyard/wiki/Plugin-System) — Writing and installing plugins
- [API Reference](https://github.com/tobayashi-san/Shipyard/wiki/API-Reference) — Full REST API documentation
- [Troubleshooting](https://github.com/tobayashi-san/Shipyard/wiki/Troubleshooting) — Common issues and solutions

## Development

```bash
npm install
npm run dev
```

Starts the backend on port `3001` and the Vite dev server on port `5173` simultaneously.

```bash
# Run backend tests
cd server && node --test
```

## Architecture

```
Browser
  │
  │  HTTPS / WebSocket
  ▼
┌──────────────────────────────────────────┐
│  Node.js + Express                       │
│                                          │
│  REST API     ──►  SQLite (better-       │
│                    sqlite3, WAL mode)    │
│  WebSocket    ──►  live terminal output  │
│  Ansible Runner  ──►  ansible-playbook   │
│  SSH Manager  ──►  node-ssh / ssh2       │
│  System Poller   ──►  SSH commands       │
│  Scheduler    ──►  node-cron             │
│  Plugin Loader   ──►  /app/plugins/      │
└──────────────────────────────────────────┘
       │ SSH               │ SSH
       ▼                   ▼
  Server A …           Server B …
```
