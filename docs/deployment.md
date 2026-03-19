# Deployment

## Docker (recommended)

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

## Bare metal

### Requirements

- **Linux** with systemd (Debian, Ubuntu, Arch, Fedora, …)
- **Node.js** 18+
- **Ansible** (`sudo apt install ansible` / `sudo pacman -S ansible` / `sudo dnf install ansible`)

```bash
git clone https://github.com/tobayashi-san/Shipyard.git
cd Shipyard
bash install.sh
```

The installer detects your OS, installs dependencies, builds the frontend, and registers a systemd service that starts automatically on boot. It also offers to enable HTTPS.

> **No systemd?** `install.sh` detects this and prints the manual start command. You can then use your own init (OpenRC, runit, …) or run it in a `tmux`/`screen` session.

### Update

```bash
git pull
cd frontend && npm run build && cd ..
sudo systemctl restart shipyard
```

### Uninstall

```bash
bash uninstall.sh
```

Stops and removes the systemd service. Optionally deletes the data directory (database, SSH keys, certificates).

---

## First Start

1. Open the app → onboarding wizard appears
2. Set a password (and optionally enable 2FA under **Settings → Security**)
3. SSH key is generated automatically
4. Add servers — optionally deploy the SSH key via password right from the UI
5. System info, updates, and containers are fetched automatically
