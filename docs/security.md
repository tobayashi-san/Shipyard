# Security Hardening

Shipyard holds SSH private keys and has direct shell access to every managed server. The following steps significantly reduce the attack surface.

---

## 1 — Keep it off the public internet

Run Shipyard on a **dedicated machine or VM** with no other internet-facing services. Expose it only via:

- **VPN** (WireGuard, Tailscale) — strongly recommended
- **Identity-aware proxy** (Cloudflare Access, Authelia) — enforces MFA before reaching Shipyard

Firewall rules on the Shipyard host should allow inbound **SSH (key-only)** and the **VPN port** only. The web interface must never be directly reachable from the internet.

---

## 2 — Set secrets via environment variables

Two secrets should live **outside** the data directory. By default both are auto-generated and stored in SQLite — an attacker with read access to `/data/` can extract them.

| Variable | Risk if left in DB |
|---|---|
| `JWT_SECRET` | Attacker can forge valid login tokens without knowing the password |
| `SHIPYARD_KEY_SECRET` | Attacker can decrypt SSH private keys in `/data/ssh/` |

Generate a value for each:
```bash
openssl rand -hex 32   # run twice, use separate values
```

**Docker** — create a new file named `docker-compose.override.yml` next to your `docker-compose.yml` (it is gitignored and never committed):

```yaml
# docker-compose.override.yml  ← create this file manually
services:
  shipyard:
    environment:
      - JWT_SECRET=your-first-value
      - SHIPYARD_KEY_SECRET=your-second-value
```

Docker Compose merges this file automatically alongside `docker-compose.yml` — no extra flags needed.

**Bare metal** — `install.sh` generates both secrets automatically and writes them into the systemd unit. If you need to rotate them later, edit `/etc/systemd/system/shipyard.service`:

```ini
[Service]
Environment="JWT_SECRET=your-first-value"
Environment="SHIPYARD_KEY_SECRET=your-second-value"
```

Then reload: `sudo systemctl daemon-reload && sudo systemctl restart shipyard`

### How SSH key encryption works

When `SHIPYARD_KEY_SECRET` is set, the private key is encrypted on disk using AES-256-GCM. It is only decrypted in memory when an SSH connection is needed. Existing plaintext keys are automatically encrypted the next time they are read — no manual migration needed.

### Setting secrets after initial setup

Both secrets can be added at any time — the container does not need to be rebuilt, only restarted.

**`JWT_SECRET` added later:** All existing login sessions become invalid immediately (tokens were signed with the old auto-generated secret). Every logged-in user will be logged out on their next request and must log in again. This happens once and is expected.

**`SHIPYARD_KEY_SECRET` added later:** On the first SSH action after restart, the existing plaintext key is automatically encrypted and the plaintext file is deleted. Fully transparent — no action required.

---

## 3 — Run as a non-root user (Docker)

The Docker image runs Node.js as the `shipyard` user (UID 1001). The entrypoint briefly runs as root to generate the TLS certificate and fix data-volume ownership, then immediately drops privileges with `gosu`.

---

## 4 — Use HTTPS and a strong password

- HTTPS is enabled by default in Docker. Never disable it.
- Set a long, randomly generated password on first start.
- Enable **2FA (TOTP)** under **Settings → Security**.
