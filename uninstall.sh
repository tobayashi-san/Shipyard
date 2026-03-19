#!/bin/bash
# Shipyard – uninstaller
set -e

echo "⚓  Shipyard uninstaller"
echo "────────────────────────"

SERVICE_FILE="/etc/systemd/system/shipyard.service"

# ── Stop and remove systemd service ──────────────────────────
if [ -f "$SERVICE_FILE" ]; then
  echo "→ Stopping and disabling shipyard service..."
  sudo systemctl stop shipyard 2>/dev/null || true
  sudo systemctl disable shipyard 2>/dev/null || true
  sudo rm -f "$SERVICE_FILE"
  sudo systemctl daemon-reload
  echo "  ✓ Service removed"
else
  echo "  No systemd service found – skipping"
fi

# ── Remove data (optional) ────────────────────────────────────
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$INSTALL_DIR/server/data"

if [ -d "$DATA_DIR" ]; then
  echo ""
  read -rp "Remove all data (database, SSH keys, certificates)? [y/N] " REMOVE_DATA
  if [[ "$REMOVE_DATA" =~ ^[Yy]$ ]]; then
    rm -rf "$DATA_DIR"
    echo "  ✓ Data removed"
  else
    echo "  Data kept at $DATA_DIR"
  fi
fi

echo ""
echo "✓ Shipyard uninstalled."
echo "  The application files remain at $INSTALL_DIR"
echo "  Remove them manually with:  rm -rf $INSTALL_DIR"
