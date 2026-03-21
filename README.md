# Shipyard

Web dashboard for managing Linux servers – SSH, system monitoring, updates, and Ansible playbooks in a single interface.

> **⚠️ Do not expose Shipyard to the public internet.**
> It stores SSH private keys and has direct shell access to all managed servers.
> Run it inside a private network or VPN. See [Security Hardening](docs/security.md).

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/tobayashi-san/Shipyard.git
cd Shipyard
docker compose up -d
```

Open **`https://<server-ip>`** in your browser. HTTPS is on by default with a self-signed certificate — accept the browser warning once, or replace it with your own certificate (see [Configuration](docs/configuration.md)).

### Bare metal

```bash
git clone https://github.com/tobayashi-san/Shipyard.git
cd Shipyard
bash install.sh
```

Detects your OS, installs dependencies, builds the frontend, and registers a systemd service.

## Screenshots

> Screenshots may be outdated and not reflect the latest UI.

![Dashboard](docs/images/Dashboard.png)

<details>
<summary>More screenshots</summary>

![Server Detail](docs/images/Server-Detail.png)
![Docker](docs/images/Docker.png)
![Terminal](docs/images/Terminal.png)
![Playbooks](docs/images/Playbooks.png)

</details>

## Features

- **Server Management** – Add, edit, delete servers; groups & tags; "Last Online" timestamp
- **System Monitoring** – CPU, RAM, disk, uptime, load average
- **OS Updates** – `apt` updates via Ansible with live terminal output
- **Custom Update Tasks** – Track tools outside apt (scripts, GitHub releases); shows current vs. latest version with update badge; streams live output
- **Docker / Podman** – Container overview, logs, restart, edit Compose stacks; image update checks
- **Ansible Playbooks** – Create and run custom playbooks
- **Scheduler** – Run playbooks on a cron schedule
- **Background Polling** – Configurable pollers (system info, OS updates, image updates, custom updates) — each with its own interval; never installs automatically
- **Dashboard** – Server health table with combined updates column; alerts for offline servers, high resource usage, and pending updates
- **SSH Terminal** – Browser-based terminal; resizable drawer, live streaming output, ANSI codes stripped
- **SSH Key Management** – Auto-generate keys and deploy them to servers
- **2FA / TOTP** – Optional two-factor authentication
- **Bilingual UI** – German and English, auto-detected from browser

## Documentation

- [Deployment](docs/deployment.md) — Docker, bare metal, updating, uninstalling
- [Configuration](docs/configuration.md) — Environment variables, HTTPS, ports
- [Security Hardening](docs/security.md) — Network isolation, secrets, encryption

## Development

```bash
npm install && npm run dev
```

Starts backend (port 3001) and Vite dev server (port 5173) simultaneously.

## How it works

```
Browser
  │
  │  HTTPS / WebSocket
  ▼
┌─────────────────────────────────────────┐
│  Node.js + Express                      │
│  REST API  ──►  SQLite                  │
│  WebSocket ──►  live terminal output    │
│  Ansible Runner  ──►  ansible-playbook  │
│  SSH Manager     ──►  node-ssh          │
│  System Poller   ──►  SSH commands      │
│  Scheduler       ──►  node-cron         │
└─────────────────────────────────────────┘
       │ SSH              │ SSH
       ▼                  ▼
  Server A …          Server B …
```

## Tests

```bash
cd server && node --test
```
