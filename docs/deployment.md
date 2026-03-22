# Deployment

## Docker

```bash
git clone https://github.com/tobayashi-san/Shipyard.git
cd Shipyard
docker compose up -d
```

Data is stored in a Docker volume (`shipyard-data`) and survives restarts and updates.

The container runs as a non-root user (`shipyard`, UID 1001). The entrypoint briefly runs as root to generate the self-signed certificate and fix volume ownership, then drops privileges before starting the server.

### Update

```bash
git pull
docker compose up -d --build
```

### Uninstall

```bash
docker compose down -v   # -v also removes the data volume
```

---

## First Start

1. Open the app → onboarding wizard appears
2. Set a password (and optionally enable 2FA under **Settings → Security**)
3. SSH key is generated automatically
4. Add servers — optionally deploy the SSH key via password right from the UI
5. System info, updates, and containers are fetched automatically
