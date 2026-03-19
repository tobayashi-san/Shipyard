#!/bin/bash
# Shipyard – bare-metal install script (Debian/Ubuntu)
set -e

echo "⚓  Shipyard installer"
echo "────────────────────────"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 18+ first."
  exit 1
fi

NODE_VERSION=$(node -e "process.exit(parseInt(process.versions.node))")
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found $(node -v))"
  exit 1
fi

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install dependencies
echo "→ Installing dependencies..."
cd "$INSTALL_DIR"
npm install --prefix . --ignore-scripts 2>/dev/null || true
cd server && npm install --omit=dev && cd ..

# Build frontend
echo "→ Building frontend..."
cd frontend && npm install && npm run build && cd ..

# Create systemd service
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
