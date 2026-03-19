# Shipyard

Web dashboard for managing Linux servers – SSH, system monitoring, updates, and Ansible playbooks in a single interface.

## Deploy in 30 seconds

### Option A – Docker (recommended)

```bash
git clone https://github.com/tobayashi-san/Shipyard.git
cd Shipyard
docker compose up -d
```

Open **https://localhost** — done.

HTTPS is enabled by default. A self-signed certificate is generated automatically on first start and stored in the data volume. Accept the browser warning once, or replace it with your own certificate (see [HTTPS](#https) below).

Data is stored in a Docker volume and survives restarts/updates.

### Option B – Bare metal (Linux / macOS)

```bash
git clone https://github.com/tobayashi-san/Shipyard.git
cd Shipyard
bash install.sh
```

Detects your OS (Debian/Ubuntu, Arch, Fedora), installs dependencies, builds the frontend, and registers a systemd service that starts automatically on boot. The installer also offers to enable HTTPS.

---

## Features

- **Server Management** – Add, edit, delete servers; tags & groups
- **System Monitoring** – CPU, RAM, disk, uptime, load average (live & cached)
- **Update Management** – `apt` updates via Ansible with live terminal output
- **Docker** – Container overview, logs, restart, edit Compose stacks
- **Ansible Playbooks** – Create and run custom playbooks
- **Scheduler** – Run playbooks on a schedule via cron
- **SSH Terminal** – Browser-based terminal directly in the dashboard
- **SSH Key Management** – Auto-generate keys and deploy them to servers
- **Authentication** – Password protection with JWT, rate limiting, audit log
- **Bilingual UI** – German and English, auto-detected from browser language

## Requirements

### Docker (Option A)
- [Docker](https://docs.docker.com/get-docker/) with Compose plugin (`docker compose version`)

### Bare metal (Option B)
- **Linux** with systemd (Debian, Ubuntu, Arch, Fedora, …)
- **Node.js** 18+
- **Ansible** (`sudo apt install ansible` / `sudo pacman -S ansible` / `sudo dnf install ansible`)
- SSH access to the managed servers

> **No systemd?** `install.sh` detects this and prints the manual start command instead. You can then set up your own init (OpenRC, runit, …) or just run it in a `screen`/`tmux` session.

## HTTPS

Shipyard supports native HTTPS via the `SSL_KEY` and `SSL_CERT` environment variables.
When both are set, the server automatically switches to HTTPS (port 443 by default).

**Docker** – HTTPS is on by default. A self-signed certificate is generated on first start and stored in the data volume (`shipyard-data`). To use your own certificate, mount it and set the env vars in `docker-compose.yml`:

```yaml
environment:
  - SSL_CERT=/certs/shipyard.crt
  - SSL_KEY=/certs/shipyard.key
volumes:
  - /etc/ssl/certs/shipyard.crt:/certs/shipyard.crt:ro
  - /etc/ssl/private/shipyard.key:/certs/shipyard.key:ro
```

**Bare metal** – `install.sh` offers to enable HTTPS during setup. It can generate a self-signed certificate automatically (via `openssl`) or accept existing certificate paths. The env vars are written into the systemd unit.

**Manual** – set env vars directly:

```bash
SSL_KEY=/path/to/key.pem SSL_CERT=/path/to/cert.pem NODE_ENV=production node server/index.js
```

> Without HTTPS, JWT tokens and SSH passwords are transmitted in plaintext.
> For production, use native HTTPS or terminate TLS via a reverse proxy (nginx, Caddy).

## First Start

1. Open the app → browser opens the onboarding wizard
2. Set a password
3. SSH key is generated automatically
4. Add servers (optional: deploy SSH key directly via password)
5. System info, updates, and containers are fetched automatically

## Uninstall

### Bare metal

```bash
bash uninstall.sh
```

Stops and removes the systemd service. Optionally deletes the data directory (database, SSH keys, certificates). The application files are not deleted — remove them manually afterwards if needed.

### Docker

```bash
docker compose down -v   # -v also removes the data volume
```

## Updating

### Docker

```bash
git pull
docker compose up -d --build
```

### Bare metal

```bash
git pull
cd frontend && npm run build && cd ..
sudo systemctl restart shipyard
```

## Development

```bash
npm install
cd server && npm install && cd ..
cd frontend && npm install && cd ..
npm run dev
```

Starts backend (port 3001) and Vite dev server (port 5173) simultaneously.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` / `443` | Backend port (443 when HTTPS is enabled) |
| `SSL_KEY` | – | Path to TLS private key – enables HTTPS when set together with `SSL_CERT` |
| `SSL_CERT` | – | Path to TLS certificate file |
| `JWT_SECRET` | (auto, DB) | JWT signing secret – set explicitly in production |
| `NODE_ENV` | – | `production` enables static file serving |
| `ALLOWED_ORIGINS` | `localhost:3000,localhost:5173` | CORS whitelist (comma-separated) |

## How it works

```
Browser
  │
  │  HTTP(S) / WebSocket (ws/wss)
  ▼
┌─────────────────────────────────────────┐
│  Node.js + Express (Backend)            │
│                                         │
│  REST API  ──►  SQLite (servers, jobs)  │
│  WebSocket ──►  live terminal output    │
│                                         │
│  Ansible Runner  ──►  ansible-playbook  │
│  SSH Manager     ──►  ssh2 (Node)       │
│  System Poller   ──►  SSH → shell cmds  │
│  Scheduler       ──►  node-cron         │
└─────────────────────────────────────────┘
       │               │
       │ SSH           │ SSH
       ▼               ▼
  Server A         Server B  …
```

**Frontend** — Vanilla JS (no framework), bundled with Vite. Single-page app with a client-side router. All UI state lives in one `state` object in `main.js`.

**Backend** — Express serves the REST API and static files in production. A WebSocket connection streams live output from Ansible runs and SSH sessions to the browser.

**Ansible** — Updates and custom playbooks are executed via `ansible-playbook` as a child process. Output is piped line by line over WebSocket to the terminal in the browser.

**SSH Terminal** — The browser connects over WebSocket (`/ws/ssh`). The backend opens a real SSH session via the `ssh2` library and proxies stdin/stdout between the browser and the remote shell. Terminal resize events (SIGWINCH) are forwarded too.

**System Monitoring** — A background poller SSHs into each server and runs shell commands (`free`, `df`, `uptime`, `uname`, …) to collect metrics. Results are cached in SQLite and served immediately; a fresh fetch runs in the background to keep data current without blocking the UI.

**SSH Key** — On first start, an ED25519 key pair is generated and stored in `server/data/ssh/`. The public key can be deployed to a server directly from the UI (password-based, one-time).

**Auth** — Single-password setup stored as a bcrypt hash in SQLite. Login returns a JWT. All API routes and WebSocket upgrades verify the token. Failed login attempts are rate-limited.

## Project Structure

```
Shipyard/
├── server/                  # Backend (Node.js + Express)
│   ├── index.js             # Entry point, REST API, WebSocket
│   ├── db.js                # SQLite database
│   ├── middleware/          # JWT auth
│   ├── routes/              # API routes
│   ├── services/            # SSH, Ansible, system info, scheduler
│   ├── playbooks/           # Ansible playbooks
│   └── data/                # Runtime data (DB, SSH key) – do not commit
├── frontend/                # Frontend (Vite + Vanilla JS)
│   ├── index.html
│   └── src/
│       ├── main.js          # Router & global state
│       ├── api.js           # Fetch client
│       ├── i18n.js          # DE/EN translations
│       ├── websocket.js     # WebSocket client
│       └── components/      # UI components
├── Dockerfile
├── docker-compose.yml
├── install.sh               # Bare-metal installer
└── package.json             # Root scripts
```

## Tests

```bash
cd server && node --test
```
