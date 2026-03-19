#!/bin/bash
# Shipyard – installer
set -e

echo "⚓  Shipyard installer"
echo "────────────────────────"

# ── OS detection ─────────────────────────────────────────────
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="${ID}"
    OS_LIKE="${ID_LIKE:-}"
  elif command -v sw_vers &>/dev/null; then
    OS_ID="macos"
    OS_LIKE=""
  else
    OS_ID="unknown"
    OS_LIKE=""
  fi
}

is_debian_based() {
  echo "$OS_ID $OS_LIKE" | grep -qiE "debian|ubuntu|raspbian|linuxmint|pop"
}

is_arch_based() {
  echo "$OS_ID $OS_LIKE" | grep -qiE "arch|manjaro|endeavouros"
}

is_fedora_based() {
  echo "$OS_ID $OS_LIKE" | grep -qiE "fedora|rhel|centos|rocky|alma"
}

has_systemd() {
  command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1
}

detect_os
echo "→ Detected OS: ${PRETTY_NAME:-$OS_ID}"

# ── macOS: not supported for systemd service ─────────────────
if [ "$OS_ID" = "macos" ]; then
  echo ""
  echo "  macOS detected. Skipping systemd service setup."
  echo "  Use Docker instead:  docker compose up -d"
  echo ""
fi

# ── Check: Node.js ───────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo ""
  echo "ERROR: Node.js not found."
  if is_debian_based; then
    echo "  Install: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  elif is_arch_based; then
    echo "  Install: sudo pacman -S nodejs npm"
  elif is_fedora_based; then
    echo "  Install: sudo dnf install nodejs"
  else
    echo "  Install Node.js 18+ from https://nodejs.org"
  fi
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found $(node -v))"
  exit 1
fi
echo "→ Node.js $(node -v) ✓"

# ── Check: Ansible ───────────────────────────────────────────
if ! command -v ansible &>/dev/null; then
  echo ""
  echo "WARNING: Ansible not found – playbook features will not work."
  if is_debian_based; then
    echo "  Install: sudo apt install -y ansible"
  elif is_arch_based; then
    echo "  Install: sudo pacman -S ansible"
  elif is_fedora_based; then
    echo "  Install: sudo dnf install ansible"
  else
    echo "  Install: pip install ansible"
  fi
  read -rp "  Continue anyway? [y/N] " CONT
  if [[ ! "$CONT" =~ ^[Yy]$ ]]; then exit 1; fi
else
  echo "→ Ansible $(ansible --version | head -1 | awk '{print $NF}') ✓"
fi

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Install dependencies ──────────────────────────────────────
echo "→ Installing dependencies..."
cd "$INSTALL_DIR"
cd server && npm install --omit=dev && cd ..

# ── Build frontend ────────────────────────────────────────────
echo "→ Building frontend..."
cd frontend && npm install && npm run build && cd ..

# ── systemd service (Linux only) ─────────────────────────────
if has_systemd && [ "$OS_ID" != "macos" ]; then
  SERVICE_FILE="/etc/systemd/system/shipyard.service"
  echo "→ Creating systemd service..."
  sudo tee "$SERVICE_FILE" > /dev/null << SERVICE
[Unit]
Description=Shipyard
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/server/index.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICE

  sudo systemctl daemon-reload
  sudo systemctl enable shipyard
  sudo systemctl start shipyard

  echo ""
  echo "✓ Shipyard running at http://localhost:3001"
  echo "  sudo systemctl status shipyard"
else
  echo ""
  echo "✓ Build complete. Start manually with:"
  echo "  NODE_ENV=production node $INSTALL_DIR/server/index.js"
fi
