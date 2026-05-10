# Configuration

## Environment Variables

Set non-secret variables in `docker-compose.yml`. Store secrets in a `.env` file next to it; Docker Compose loads this file automatically.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | — | Set to `production` for production use. Enables CSP and static frontend serving. |
| `JWT_SECRET` | **Yes in production** | — | JWT signing key. Use `openssl rand -hex 32`. Changing it logs out existing sessions. |
| `SHIPYARD_KEY_SECRET` | Strongly recommended | — | Master encryption key for SSH keys, SMTP passwords, Git tokens, webhook secrets, and TOTP secrets stored at rest. Use `openssl rand -hex 32`. |
| `PORT` | No | `443` with HTTPS, `3001` with HTTP | Listen port. |
| `SSL_CERT` | No | Auto-generated self-signed certificate | Path to TLS certificate file inside the container. |
| `SSL_KEY` | No | Auto-generated self-signed key | Path to TLS private key file inside the container. |
| `CERT_SANS` | No | Hostname/container IP/localhost | Extra SANs for generated self-signed certificates, for example `IP:10.30.1.10,DNS:shipyard.example.com`. |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000,http://localhost:5174` | CORS allowed origins for browser requests and WebSocket origin checks. |
| `TRUST_PROXY` | No | `0` | Set to `1` or a trusted proxy configuration when running behind a reverse proxy that sets `X-Forwarded-*` headers. |
| `DB_PATH` | No | `/app/server/data/shipyard.db` | SQLite database file path. |
| `GITHUB_TOKEN` | No | — | GitHub personal access token to avoid API rate limits for Custom Update Tasks. |
| `PLUGINS_DIR` | No | `/app/plugins` | Runtime plugin directory. |

## Application Settings

These are configured in the UI under **Settings**, or via the API (`PUT /api/system/settings`).

### Branding / White Label

| Setting | Default | Description |
|---------|---------|-------------|
| App Name | `Shipyard` | Shown in sidebar and login screen. |
| Tagline | `Infrastructure` | Subtitle below the app name. |
| Accent Color | `#3b82f6` | Primary UI color for buttons, links, and active states. |
| Theme | `auto` | `auto` follows OS, or use `light` / `dark`. |
| Time Format | `24h` | `24h` or `12h`. |

### Agent Feature

| Setting | Default | Description |
|---------|---------|-------------|
| Enable agent feature | Off, auto-enabled on migration when agent configs exist | Shows Agent tab/UI and enables agent admin API endpoints. |

Agent push/auto mode requires HTTPS. If you use the generated self-signed certificate, set `CERT_SANS` so managed servers can verify the URL they use to reach Shipyard.

### Notifications

#### Webhooks

Supported platforms with auto-detected formatting:

- **Discord** — rich embeds with color-coded status
- **Slack** — formatted message with attachment
- **Generic** — JSON payload `{ title, message, success, timestamp }`

| Setting | Description |
|---------|-------------|
| Webhook URL | Full URL to the webhook endpoint. |
| Webhook Secret | Bearer token sent in `Authorization` header. Stored encrypted when `SHIPYARD_KEY_SECRET` is set. |

#### Email (SMTP)

| Setting | Description |
|---------|-------------|
| SMTP Host | Mail server hostname. |
| SMTP Port | `465` for TLS, `587` for STARTTLS. |
| SMTP User | Authentication username. |
| SMTP Password | Authentication password. Stored encrypted when `SHIPYARD_KEY_SECRET` is set. |
| From Address | Sender email address. |
| To Address | Recipient email address. |

#### Triggers

| Setting | Default | Description |
|---------|---------|-------------|
| Notify on playbook failure | Off | Send notification when a scheduled playbook fails. |
| Notify on update failure | Off | Send notification when an update operation fails. |

### Polling Intervals

Background tasks that periodically check your servers:

| Task | Default | Setting Key | Description |
|------|---------|-------------|-------------|
| System Info | 5 min | `poll_info_interval_min` | OS, CPU, RAM, disk, uptime, load, reboot status. Uses SSH fallback when no fresh agent data exists. |
| Package Updates | 60 min | `poll_updates_interval_min` | apt/dnf/yum/pacman/zypper package updates. |
| Docker Image Updates | 360 min | `poll_image_updates_interval_min` | Checks Docker registries for newer image tags. |
| Custom Updates | 360 min | `poll_custom_updates_interval_min` | Runs user-defined version check commands. |

Each can be individually enabled or disabled. Changes take effect within one polling cycle.

## Database

Shipyard uses **SQLite** with WAL mode for concurrent read/write performance. The database file is:

```text
/app/server/data/shipyard.db
```

Migrations run automatically on startup.

### Backup

```bash
# Stop first for a simple clean copy
docker compose stop
cp -r data/ data-backup/
docker compose start
```

If you use a named Docker volume instead of `./data`, back up the volume from the Docker host.

## Frontend

Production serves the React/Vite build from:

```text
frontend-next/dist
```

Development:

```bash
cd server && npm run dev
cd frontend-next && npm run dev
```

The frontend dev server listens on port `5174` and proxies API/WebSocket calls to the backend on port `3001`.

