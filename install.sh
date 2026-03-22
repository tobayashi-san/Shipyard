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
    echo "  Install Node.js 20+ from https://nodejs.org"
  fi
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required (found $(node -v))"
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
  echo "→ Ansible $(ansible --version | head -1) ✓"
fi

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── HTTPS setup ───────────────────────────────────────────────
SSL_KEY_ENV=""
SSL_CERT_ENV=""

echo ""
read -rp "Enable HTTPS? [y/N] " USE_HTTPS
if [[ "$USE_HTTPS" =~ ^[Yy]$ ]]; then
  echo ""
  echo "  Options:"
  echo "    1) Generate a self-signed certificate (for testing / internal use)"
  echo "    2) Use existing certificate files"
  read -rp "  Choose [1/2]: " CERT_CHOICE

  if [ "$CERT_CHOICE" = "1" ]; then
    CERT_DIR="$INSTALL_DIR/server/data/certs"
    mkdir -p "$CERT_DIR"
    CERT_FILE="$CERT_DIR/shipyard.crt"
    KEY_FILE="$CERT_DIR/shipyard.key"
    if command -v openssl &>/dev/null; then
      openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$KEY_FILE" -out "$CERT_FILE" \
        -subj "/CN=shipyard" &>/dev/null
      chmod 600 "$KEY_FILE"
      echo "  ✓ Self-signed certificate generated in $CERT_DIR"
    else
      echo "  ERROR: openssl not found. Install openssl and re-run, or choose option 2."
      exit 1
    fi
    SSL_KEY_ENV="$KEY_FILE"
    SSL_CERT_ENV="$CERT_FILE"
  else
    read -rp "  Path to private key file:   " SSL_KEY_ENV
    read -rp "  Path to certificate file:   " SSL_CERT_ENV
    if [ ! -f "$SSL_KEY_ENV" ] || [ ! -f "$SSL_CERT_ENV" ]; then
      echo "  ERROR: One or both certificate files not found."
      exit 1
    fi
  fi
  echo "  → HTTPS enabled (port 443)"
fi

# ── Install dependencies ──────────────────────────────────────
echo "→ Installing dependencies..."
cd "$INSTALL_DIR"
cd server && npm install --omit=dev && cd ..

# ── Build frontend ────────────────────────────────────────────
echo "→ Building frontend..."
cd frontend && npm install && npm run build && cd ..

# ── Security secrets ──────────────────────────────────────────
echo ""
echo "→ Generating security secrets..."
if command -v openssl &>/dev/null; then
  JWT_SECRET_VAL="$(openssl rand -hex 32)"
  KEY_SECRET_VAL="$(openssl rand -hex 32)"
  echo "  ✓ JWT_SECRET and SHIPYARD_KEY_SECRET generated"
else
  echo "  WARNING: openssl not found – secrets not generated."
  echo "  Set JWT_SECRET and SHIPYARD_KEY_SECRET manually in the systemd unit."
  JWT_SECRET_VAL=""
  KEY_SECRET_VAL=""
fi

# ── systemd service (Linux only) ─────────────────────────────
if has_systemd && [ "$OS_ID" != "macos" ]; then
  SERVICE_FILE="/etc/systemd/system/shipyard.service"
  echo "→ Creating systemd service..."

  # Use the real user even when called via sudo
  SERVICE_USER="${SUDO_USER:-$USER}"
  if [ "$SERVICE_USER" = "root" ]; then
    echo "  WARNING: Running as root. The service will run as root."
    echo "  For better security, create a dedicated user and re-run install.sh as that user."
  fi

  HTTPS_ENV_LINES=""
  START_URL="http://localhost:3001"
  if [ -n "$SSL_KEY_ENV" ]; then
    HTTPS_ENV_LINES="Environment=SSL_KEY=${SSL_KEY_ENV}
Environment=SSL_CERT=${SSL_CERT_ENV}"
    START_URL="https://localhost:443"
  fi

  ENV_FILE="/etc/shipyard/env"
  sudo mkdir -p /etc/shipyard
  {
    echo "NODE_ENV=production"
    [ -n "$SSL_KEY_ENV" ] && echo "SSL_KEY=${SSL_KEY_ENV}" && echo "SSL_CERT=${SSL_CERT_ENV}"
    [ -n "$JWT_SECRET_VAL" ] && echo "JWT_SECRET=${JWT_SECRET_VAL}" && echo "SHIPYARD_KEY_SECRET=${KEY_SECRET_VAL}"
  } | sudo tee "$ENV_FILE" > /dev/null
  sudo chmod 600 "$ENV_FILE"
  sudo chown root:root "$ENV_FILE"

  sudo tee "$SERVICE_FILE" > /dev/null << SERVICE
[Unit]
Description=Shipyard
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/server/index.js
Restart=on-failure
EnvironmentFile=${ENV_FILE}

[Install]
WantedBy=multi-user.target
SERVICE

  sudo systemctl daemon-reload
  sudo systemctl enable shipyard
  sudo systemctl start shipyard

  echo ""
  echo "✓ Shipyard running at $START_URL"
  echo "  sudo systemctl status shipyard"
else
  echo ""
  ENV_FILE="$INSTALL_DIR/.env"
  {
    echo "NODE_ENV=production"
    [ -n "$SSL_KEY_ENV" ] && echo "SSL_KEY=${SSL_KEY_ENV}" && echo "SSL_CERT=${SSL_CERT_ENV}"
    [ -n "$JWT_SECRET_VAL" ] && echo "JWT_SECRET=${JWT_SECRET_VAL}" && echo "SHIPYARD_KEY_SECRET=${KEY_SECRET_VAL}"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "✓ Build complete. Secrets saved to $ENV_FILE (mode 600)"
  echo "  Start with: env \$(cat $ENV_FILE | xargs) node $INSTALL_DIR/server/index.js"
fi
