# Shipyard

Web dashboard for managing Linux servers – SSH, system monitoring, updates, and Ansible playbooks in a single interface.

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

- **Node.js** 18+
- **Ansible** (`sudo apt install ansible`)
- SSH access to the managed servers

## Installation

```bash
npm install
cd server && npm install && cd ..
cd frontend && npm install && cd ..
```

## Starting

### Development

```bash
npm run dev
```

Starts the backend (port 3001) and Vite dev server (port 5173) simultaneously.

### Production

```bash
cd frontend && npm run build && cd ..
NODE_ENV=production node server/index.js
```

The backend then serves the built frontend at `http://localhost:3001`.

## Security Note

> **HTTPS is required for production use.**
>
> The tool transmits an SSH password during key deployment as well as JWT tokens.
> Without HTTPS, these can be intercepted on the network.
>
> Recommendation: use nginx or Caddy as a reverse proxy with TLS termination.

## First Start

1. Start the app → browser opens the onboarding wizard
2. Set a password
3. SSH key is generated automatically
4. Add servers (optional: deploy SSH key directly via password)
5. System info, updates, and containers are fetched automatically

## Project Structure

```
lab_manager/
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
└── package.json             # Root scripts
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend port |
| `JWT_SECRET` | (auto, DB) | JWT signing secret – set explicitly in production |
| `NODE_ENV` | – | `production` enables static file serving |
| `ALLOWED_ORIGINS` | `localhost:3000,localhost:5173` | CORS whitelist (comma-separated) |

## Tests

```bash
cd server && node --test
```
