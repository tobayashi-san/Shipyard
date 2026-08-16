# Fleet (Shipyard)

Fleet is the Shipyard console for Linux infrastructure — managed hosts, SSH
access, Docker workloads, updates, Ansible automation, Proxmox inventory, and
OpenTofu deployments in a single interface. The repository, container image,
data paths, and `SHIPYARD_*` configuration names retain the Shipyard name for
upgrade compatibility.

> **Do not expose Shipyard to the public internet.**
> It stores SSH private keys and has direct shell access to all managed servers.
> Run it inside a private network or VPN. See [Docker deployment](docs/DOCKER_DEPLOYMENT.md).

## Docker deployment

The supported production path is Docker Compose. Follow the concise,
security-focused guide in [Docker deployment](docs/DOCKER_DEPLOYMENT.md). It
covers secret generation, localhost-by-default networking, TLS, backups, and
safe updates.

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

By default the supplied Compose file binds Shipyard to **`https://localhost`**.
Set an explicit private-LAN bind address in `.env` only when access is protected
by a firewall or VPN. The setup wizard will guide you through account creation,
appearance settings, and SSH key generation.
The setup wizard appears only when no users exist; otherwise you will see the login page.

HTTPS is enabled by default with a self-signed certificate. Accept the browser
warning once or configure your own certificate as described in
[Docker deployment](docs/DOCKER_DEPLOYMENT.md#network-and-tls).
For agent push/auto mode, set `CERT_SANS` to the LAN IP or DNS name that managed servers use to reach Shipyard.

## Update

```bash
docker compose pull
docker compose up -d --wait
```

With `:latest`, this updates Shipyard to the newest **stable** release.
Release candidates are published as explicit versioned tags (for example `:1.0.1-rc.1`) and do not move `latest`.

## Container Images

Images are published to GitHub Container Registry:

- Stable releases: `ghcr.io/tobayashi-san/shipyard:latest`
- Versioned releases: `ghcr.io/tobayashi-san/shipyard:<version>`
- Release candidates: `ghcr.io/tobayashi-san/shipyard:<version>-rc.<n>`

The Docker image serves the React frontend from `frontend-next/dist`, includes OpenTofu as a built-in server feature, and bundles the starter playbooks. Optional plugins remain operator-managed in `/app/plugins`.

### Plugin trust

Plugins run as server-side code and have the same access as Shipyard itself. Install plugins only from sources you trust. In production Shipyard logs the digest of untrusted plugins. For a strict allowlist, set `SHIPYARD_PLUGIN_TRUST_POLICY=enforce` and `SHIPYARD_TRUSTED_PLUGIN_SHA256=plugin-id:<sha256>` (multiple entries are comma-separated). Obtain the digest from the plugin list/log after reviewing the plugin contents, then pin it before enabling strict mode.

## Documentation

- [Docker deployment](docs/DOCKER_DEPLOYMENT.md) — installation, networking,
  TLS, persistent data, and updates
- [Development pipeline](docs/DEVELOPMENT_PIPELINE.md) — local checks, CI, and
  releases

The application itself is the source of truth for feature-level help. UI
screenshots are intentionally not stored in the repository because they become
stale whenever the console design changes.

## Features

- **Managed hosts** — add, edit, group, tag, attach quick links, and bulk import/export (JSON or CSV)
- **Host state** — inspect CPU, RAM, disk, mounted storage, uptime, and load average via SSH or the optional Shipyard Agent
- **OS Updates** — via Ansible (`apt`, `dnf`, `pacman`, …) with live terminal output
- **Custom Update Tasks** — track scripts or GitHub releases, shows current vs. latest
- **Docker & Compose** — container overview, logs, restart, edit and run Compose stacks
- **Ansible** — built-in YAML editor, version history, cron scheduler, live output
- **SSH Terminal** — browser-based, resizable, ANSI-aware, with live session status
- **SFTP File Transfer** — browse, upload, download, and stream files between managed hosts
- **SSH Key Management** — auto-generate Ed25519, deploy via UI, AES-256-GCM encryption at rest
- **Notifications** — webhooks (Discord, Slack) and SMTP email alerts
- **Auth & Security** — JWT, host- and capability-scoped RBAC, custom roles, TOTP/2FA, audit log, rate limiting, and HTTPS
- **Proxmox inventory** — discover QEMU VMs and LXC containers, inspect configuration and snapshots, run power actions, and adopt either guest type as a managed Linux host
- **Deployments** — environment-scoped OpenTofu plans, reviewed-plan Apply, drift checks, encrypted local-state recovery, run locking, and Proxmox VM blueprints
- **Plugins** — hot-reloadable extensions with scoped UI and API integration
- **UI** — English, light/dark/system theme, white-label support

## Development

```bash
# Install root dev tools
npm ci

# Backend (port 3001)
cd server && npm ci && npm run dev

# Frontend (port 5174) — in a second terminal
cd frontend-next && npm ci && npm run dev
```

```bash
# Run backend tests
cd server && npm test

# Run one backend test file
cd server && node --test test/auth.test.js

# Build frontend
cd frontend-next && npm run build
```

Production mode serves the frontend build from `frontend-next/dist` at the
application root.

For the full PR, CI, release-candidate, and stable-release workflow, see [Development Pipeline](docs/DEVELOPMENT_PIPELINE.md).

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
│  Agent Ingest    ──►  runner metrics     │
│  Scheduler    ──►  node-cron             │
│  Plugin Loader   ──►  /app/plugins/      │
└──────────────────────────────────────────┘
       │ SSH               │ SSH
       ▼                   ▼
  Server A …           Server B …
```
