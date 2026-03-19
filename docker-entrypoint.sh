#!/bin/sh
# Auto-generate a self-signed certificate if none is provided.
# Certs are stored in the data volume so they survive restarts.

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

exec node server/index.js
