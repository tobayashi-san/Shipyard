#!/bin/sh
# Runs as root:
#   1. Generate self-signed certificate if none is provided
#   2. Fix data-volume ownership
#   3. Drop privileges to the non-root "shipyard" user

CERT_DIR="/app/server/data/certs"
DEFAULT_KEY="$CERT_DIR/shipyard.key"
DEFAULT_CERT="$CERT_DIR/shipyard.crt"

if [ -z "$SSL_KEY" ] || [ -z "$SSL_CERT" ]; then
  mkdir -p "$CERT_DIR"

  if [ ! -f "$DEFAULT_KEY" ] || [ ! -f "$DEFAULT_CERT" ]; then
    echo "[HTTPS] Generating self-signed certificate..."
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout "$DEFAULT_KEY" -out "$DEFAULT_CERT" \
      -subj "/CN=shipyard" 2>/dev/null
    chmod 600 "$DEFAULT_KEY"
    echo "[HTTPS] Certificate saved to $CERT_DIR"
  fi

  export SSL_KEY="$DEFAULT_KEY"
  export SSL_CERT="$DEFAULT_CERT"
fi

# Ensure writable directories are owned by the shipyard user
# (Docker volumes are created as root on first use)
chown -R shipyard:shipyard /app/server/data /app/server/playbooks /app/plugins

# Drop from root to shipyard and start the server
exec gosu shipyard node server/index.js
