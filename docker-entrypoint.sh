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
    openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
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
mkdir -p /app/server/data/bin
chown -R shipyard:shipyard /app/server/data /app/server/playbooks /app/plugins
[ -d /workspaces ] && chown shipyard:shipyard /workspaces

# Seed bundled plugins into the volume; update if the bundled version changed
if [ -d /app/bundled-plugins ]; then
  for plugin_dir in /app/bundled-plugins/*/; do
    plugin_id=$(basename "$plugin_dir")
    bundled_ver=$(grep '"version"' "$plugin_dir/manifest.json" 2>/dev/null | head -1 \
                  | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    installed_ver=$(cat "/app/plugins/$plugin_id/.bundle-version" 2>/dev/null || echo "")

    if [ ! -d "/app/plugins/$plugin_id" ]; then
      echo "[plugins] Installing bundled plugin: $plugin_id ($bundled_ver)"
      cp -r "$plugin_dir" "/app/plugins/$plugin_id"
      echo "$bundled_ver" > "/app/plugins/$plugin_id/.bundle-version"
      chown -R shipyard:shipyard "/app/plugins/$plugin_id"
    elif [ -n "$bundled_ver" ] && [ "$bundled_ver" != "$installed_ver" ]; then
      echo "[plugins] Updating bundled plugin: $plugin_id ($installed_ver -> $bundled_ver)"
      cp -r "$plugin_dir/." "/app/plugins/$plugin_id/"
      echo "$bundled_ver" > "/app/plugins/$plugin_id/.bundle-version"
      chown -R shipyard:shipyard "/app/plugins/$plugin_id"
    fi
  done
fi

# Fix ownership of OpenTofu workspace directories registered by the plugin
TOFU_PATHS="/app/server/data/tofu-workspace-paths.txt"
if [ -f "$TOFU_PATHS" ]; then
  while IFS= read -r wspath; do
    [ -z "$wspath" ] && continue
    if [ -d "$wspath" ]; then
      chown -R shipyard:shipyard "$wspath"
      echo "[tofu] Fixed ownership: $wspath"
    fi
  done < "$TOFU_PATHS"
fi

# Drop from root to shipyard and start the server
exec gosu shipyard node server/index.js
