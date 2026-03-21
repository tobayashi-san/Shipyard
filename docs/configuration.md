# Configuration

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` / `443` | Backend port (443 when HTTPS is active) |
| `SSL_KEY` | – | Path to TLS private key — enables HTTPS when set with `SSL_CERT` |
| `SSL_CERT` | – | Path to TLS certificate |
| `JWT_SECRET` | (auto, stored in DB) | JWT signing secret — **set explicitly in production** |
| `SHIPYARD_KEY_SECRET` | – | Enables AES-256-GCM encryption of SSH private keys at rest — **recommended** |
| `GITHUB_TOKEN` | – | Optional personal access token for GitHub API — avoids rate limits when Custom Update Tasks fetch the latest release from GitHub |
| `NODE_ENV` | – | Set to `production` to enable static file serving |
| `ALLOWED_ORIGINS` | `localhost:3000,localhost:5173` | CORS whitelist (comma-separated) |

For production deployments, set `JWT_SECRET` and `SHIPYARD_KEY_SECRET` outside the data directory. See [Security Hardening](security.md).

---

## HTTPS

HTTPS is enabled by default in Docker via a self-signed certificate (generated on first start, stored in the data volume).

### Use your own certificate (Docker)

```yaml
# docker-compose.yml
environment:
  - SSL_CERT=/certs/shipyard.crt
  - SSL_KEY=/certs/shipyard.key
volumes:
  - /etc/ssl/certs/shipyard.crt:/certs/shipyard.crt:ro
  - /etc/ssl/private/shipyard.key:/certs/shipyard.key:ro
```

### Bare metal

`install.sh` offers to enable HTTPS during setup — it can generate a self-signed certificate automatically or accept existing paths. The env vars are written into the systemd unit.

Manual:
```bash
SSL_KEY=/path/to/key.pem SSL_CERT=/path/to/cert.pem node server/index.js
```

> Without HTTPS, JWT tokens and SSH passwords are transmitted in plaintext.

---

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
│   └── data/                # Runtime data (DB, SSH key) – never commit
├── frontend/                # Frontend (Vite + Vanilla JS)
│   ├── index.html
│   └── src/
│       ├── main.js          # Router & global state
│       ├── api.js           # Fetch client
│       ├── i18n.js          # DE/EN translations
│       ├── websocket.js     # WebSocket client
│       └── components/      # UI components
├── docs/                    # Documentation
├── Dockerfile
├── docker-compose.yml
├── install.sh               # Bare-metal installer
└── package.json
```
