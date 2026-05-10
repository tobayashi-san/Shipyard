# Configuration

Shipyard is configured through environment variables, mounted volumes, and settings in the web UI.

## Required Environment Variables

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs authentication tokens. Required in production. |
| `SHIPYARD_KEY_SECRET` | Encrypts stored secrets such as SSH keys and TOTP secrets. |

Generate both with high entropy:

```bash
openssl rand -hex 32
```

Changing `JWT_SECRET` logs out existing sessions. Changing `SHIPYARD_KEY_SECRET` prevents decrypting secrets written with the old key.

## Optional Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | Server listen port. Defaults to `443` when TLS is enabled, otherwise `3001`. |
| `SSL_CERT` | Path to TLS certificate inside the container. |
| `SSL_KEY` | Path to TLS private key inside the container. |
| `CERT_SANS` | Extra SAN entries for the generated self-signed certificate. |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed for CORS/WebSocket checks. |
| `TRUST_PROXY` | Enable when running behind a reverse proxy that sets `X-Forwarded-*` headers. |

## Volumes

| Container Path | Purpose |
|---|---|
| `/app/server/data` | SQLite database, generated certificates, cached data, internal state. |
| `/app/server/playbooks` | User-visible playbooks. |
| `/app/plugins` | Runtime plugins. |
| `/workspaces` | Optional OpenTofu/Terraform workspace bind mount. |

## Frontend

Production serves the built React frontend from `frontend-next/dist` at the application root.

Development uses:

```bash
cd server && npm run dev
cd frontend-next && npm run dev
```

The frontend dev server listens on port `5174` and proxies API/WebSocket calls to the backend on port `3001`.

