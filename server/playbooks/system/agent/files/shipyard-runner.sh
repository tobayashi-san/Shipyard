#!/bin/bash
# ─────────────────────────────────────────────────────────
# Shipyard Runner Agent v3 – Hybrid (Push + Pull)
#
# Zwei Modi, selber Agent:
#
#   PUSH-Modus (Server kann Shipyard erreichen):
#     Agent holt Manifest per HTTPS, schickt Ergebnisse zurück.
#     → MODE=push  SHIPYARD_URL=https://...
#
#   PULL-Modus (Server kann Shipyard NICHT erreichen):
#     Shipyard schreibt Manifest per SSH in eine lokale Datei.
#     Agent liest die Datei, führt Collectors aus, schreibt
#     Ergebnisse in eine lokale Output-Datei.
#     Shipyard holt die Output-Datei per SSH ab.
#     → MODE=pull  (kein SHIPYARD_URL nötig)
#
# Der Modus wird einmal bei Installation gesetzt.
# Der Agent-Code ist in beiden Modi identisch.
# ─────────────────────────────────────────────────────────

set -euo pipefail

# ── Konfiguration ──────────────────────────────────────────
MODE="${MODE:-auto}"                     # push | pull | auto
SHIPYARD_URL="${SHIPYARD_URL:-}"
AGENT_TOKEN="${AGENT_TOKEN:-}"
SHIPYARD_CA_CERT="${SHIPYARD_CA_CERT:-}"
RUNNER_VERSION="3.0.0"
HOSTNAME_ID=$(hostname -f 2>/dev/null || hostname)

# Pull-Modus: Lokale Dateipfade
DATA_DIR="${DATA_DIR:-/var/lib/shipyard-agent}"
MANIFEST_FILE="${DATA_DIR}/manifest.json"
REPORT_FILE="${DATA_DIR}/report.json"
LOCK_FILE="${DATA_DIR}/.report.lock"

# Sicherheitslimits
MAX_CMD_TIMEOUT=10
MAX_OUTPUT_BYTES=65536
MANIFEST_MAX_BYTES=131072

# Temp-Verzeichnis
WORKDIR=$(mktemp -d /tmp/shipyard-runner.XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

# ── Auto-Erkennung des Modus ──────────────────────────────

detect_mode() {
  if [ "$MODE" != "auto" ]; then
    echo "$MODE"
    return
  fi

  # Wenn SHIPYARD_URL gesetzt ist, prüfe ob erreichbar
  if [ -n "$SHIPYARD_URL" ]; then
    local http_code
    local tls_args=()
    if [ -n "$SHIPYARD_CA_CERT" ] && [ -f "$SHIPYARD_CA_CERT" ]; then
      tls_args+=(--cacert "$SHIPYARD_CA_CERT")
    fi
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 5 \
      --connect-timeout 3 \
      "${tls_args[@]}" \
      "${SHIPYARD_URL}/api/health" 2>/dev/null) || true

    if [ "$http_code" = "200" ] || [ "$http_code" = "401" ]; then
      echo "push"
      return
    fi
  fi

  # Fallback: Pull-Modus
  echo "pull"
}

# ── Befehls-Whitelist (identisch zu v2) ────────────────────
ALLOWED_COMMANDS=(
  "cat" "awk" "grep" "head" "tail" "wc" "df" "free"
  "uptime" "hostname" "uname" "id" "ps" "docker"
  "systemctl" "journalctl" "ip" "ss" "date" "stat"
  "ls" "find" "du" "nproc" "lsblk" "mountpoint"
)

is_command_allowed() {
  local binary
  binary=$(basename "$(echo "$1" | awk '{print $1}')")
  for allowed in "${ALLOWED_COMMANDS[@]}"; do
    [ "$binary" = "$allowed" ] && return 0
  done
  return 1
}

is_pattern_blocked() {
  echo "$1" | grep -qE '(curl|wget|nc|ncat|bash -c|eval|exec|rm |mkfs|dd |>|>>|tee )' && return 0
  return 1
}

# ── Manifest lesen (modusabhängig) ─────────────────────────

fetch_manifest_push() {
  local manifest_file="${WORKDIR}/manifest.json"
  local http_code
  local tls_args=()
  if [ -n "$SHIPYARD_CA_CERT" ] && [ -f "$SHIPYARD_CA_CERT" ]; then
    tls_args+=(--cacert "$SHIPYARD_CA_CERT")
  fi
  http_code=$(curl -s -o "$manifest_file" -w "%{http_code}" \
    --max-time 15 \
    --max-filesize "$MANIFEST_MAX_BYTES" \
    "${tls_args[@]}" \
    -H "Authorization: Bearer ${AGENT_TOKEN}" \
    -H "X-Runner-Version: ${RUNNER_VERSION}" \
    -H "X-Runner-Hostname: ${HOSTNAME_ID}" \
    "${SHIPYARD_URL}/api/v1/agent/manifest" 2>/dev/null) || true

  case "$http_code" in
    200) cat "$manifest_file" ;;
    304) echo "__UNCHANGED__" ;;
    *)   echo "PUSH: Manifest-Abruf fehlgeschlagen (HTTP ${http_code})" >&2; return 1 ;;
  esac
}

fetch_manifest_pull() {
  # Manifest wurde von Shipyard per SSH hierhin geschrieben
  if [ ! -f "$MANIFEST_FILE" ]; then
    echo "PULL: Kein Manifest unter ${MANIFEST_FILE}" >&2
    return 1
  fi

  # Prüfe ob Manifest aktuell genug ist (max 1h alt)
  local file_age
  file_age=$(( $(date +%s) - $(stat -c %Y "$MANIFEST_FILE" 2>/dev/null || echo 0) ))
  if [ "$file_age" -gt 3600 ]; then
    echo "PULL: Manifest ist ${file_age}s alt, möglicherweise veraltet" >&2
  fi

  cat "$MANIFEST_FILE"
}

fetch_manifest() {
  case "$ACTIVE_MODE" in
    push) fetch_manifest_push ;;
    pull) fetch_manifest_pull ;;
  esac
}

# ── Ergebnisse senden (modusabhängig) ──────────────────────

push_report_https() {
  local report="$1"
  local http_code
  local tls_args=()
  if [ -n "$SHIPYARD_CA_CERT" ] && [ -f "$SHIPYARD_CA_CERT" ]; then
    tls_args+=(--cacert "$SHIPYARD_CA_CERT")
  fi
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 15 \
    "${tls_args[@]}" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AGENT_TOKEN}" \
    -d "$report" \
    "${SHIPYARD_URL}/api/v1/agent/report" 2>/dev/null) || true

  if [ "$http_code" != "200" ] && [ "$http_code" != "201" ] && [ "$http_code" != "204" ]; then
    echo "$(date -Iseconds) PUSH: Report fehlgeschlagen (HTTP ${http_code})" >&2
  fi
}

push_report_local() {
  local report="$1"

  # Atomisch schreiben: erst in temp, dann umbenennen
  # So liest Shipyard nie eine halb geschriebene Datei
  local tmp_report="${REPORT_FILE}.tmp"
  echo "$report" > "$tmp_report"
  mv -f "$tmp_report" "$REPORT_FILE"
}

send_report() {
  case "$ACTIVE_MODE" in
    push) push_report_https "$1" ;;
    pull) push_report_local "$1" ;;
  esac
}

# ── Collector-Logik (identisch zu v2) ──────────────────────

parse_collectors() {
  local manifest="$1"
  echo "$manifest" | awk '
    BEGIN { id=""; cmd=""; timeout=5 }
    /"id"/ {
      gsub(/.*"id"[[:space:]]*:[[:space:]]*"/, "");
      gsub(/".*/, "");
      id=$0
    }
    /"cmd"/ {
      gsub(/.*"cmd"[[:space:]]*:[[:space:]]*"/, "");
      gsub(/"[[:space:]]*,?[[:space:]]*$/, "");
      gsub(/\\n/, "\n");
      gsub(/\\\|/, "|");
      gsub(/\\"/, "\"");
      cmd=$0
    }
    /"timeout"/ {
      gsub(/.*"timeout"[[:space:]]*:[[:space:]]*/, "");
      gsub(/[^0-9]/, "");
      timeout=$0
    }
    /\}/ {
      if (id != "" && cmd != "") {
        t = (timeout + 0 > 0) ? timeout + 0 : 5
        if (t > '"$MAX_CMD_TIMEOUT"') t = '"$MAX_CMD_TIMEOUT"'
        print id "\t" cmd "\t" t
      }
      id=""; cmd=""; timeout=5
    }
  '
}

get_manifest_version() {
  echo "$1" | awk -F: '/"version"/ {gsub(/[^0-9]/,"",$2); print $2; exit}'
}

get_manifest_interval() {
  local interval
  interval=$(echo "$1" | awk -F: '/"interval"/ {gsub(/[^0-9]/,"",$2); print $2; exit}')
  echo "${interval:-30}"
}

run_collector() {
  local id="$1" cmd="$2" timeout="$3"
  local output_file="${WORKDIR}/out_${id}"

  if ! is_command_allowed "$cmd"; then
    echo "{\"id\":\"${id}\",\"error\":\"blocked\",\"output\":\"\"}"
    return
  fi

  if is_pattern_blocked "$cmd"; then
    echo "{\"id\":\"${id}\",\"error\":\"blocked_pattern\",\"output\":\"\"}"
    return
  fi

  local exit_code=0
  timeout "$timeout" bash -c "$cmd" 2>/dev/null \
    | head -c "$MAX_OUTPUT_BYTES" \
    > "$output_file" || exit_code=$?

  local output
  output=$(cat "$output_file" 2>/dev/null || echo "")
  output=$(echo "$output" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' '§' | sed 's/§/\\n/g')

  if [ $exit_code -eq 0 ]; then
    echo "{\"id\":\"${id}\",\"error\":null,\"output\":\"${output}\"}"
  else
    echo "{\"id\":\"${id}\",\"error\":\"exit_${exit_code}\",\"output\":\"${output}\"}"
  fi
}

# ── Report zusammenbauen ───────────────────────────────────

build_report() {
  local manifest_version="$1"
  shift
  local results=("$@")

  local report="{"
  report+="\"hostname\":\"${HOSTNAME_ID}\","
  report+="\"timestamp\":$(date +%s),"
  report+="\"runner_version\":\"${RUNNER_VERSION}\","
  report+="\"mode\":\"${ACTIVE_MODE}\","
  report+="\"manifest_version\":${manifest_version},"
  report+="\"collectors\":["

  local first=true
  for result in "${results[@]}"; do
    [ "$first" = true ] && first=false || report+=","
    report+="$result"
  done

  report+="]}"
  echo "$report"
}

# ── Initialisierung ───────────────────────────────────────

init_pull_mode() {
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
}

# ── Hauptschleife ──────────────────────────────────────────

ACTIVE_MODE=$(detect_mode)

if [ "$ACTIVE_MODE" = "push" ] && ! echo "$SHIPYARD_URL" | grep -qE '^https://'; then
  echo "PUSH: SHIPYARD_URL muss mit https:// beginnen" >&2
  exit 1
fi

if [ "$ACTIVE_MODE" = "pull" ]; then
  init_pull_mode
fi

# Einmal-Modus
if [ "${1:-}" = "--once" ]; then
  manifest=$(fetch_manifest) || exit 1
  [ "$manifest" = "__UNCHANGED__" ] && exit 0
  version=$(get_manifest_version "$manifest")
  results=()
  while IFS=$'\t' read -r id cmd timeout; do
    [ -z "$id" ] && continue
    results+=("$(run_collector "$id" "$cmd" "$timeout")")
  done < <(parse_collectors "$manifest")
  report=$(build_report "${version:-0}" "${results[@]}")
  send_report "$report"
  exit 0
fi

echo "Shipyard Runner v${RUNNER_VERSION} (Modus: ${ACTIVE_MODE}, Host: ${HOSTNAME_ID})"

CURRENT_MANIFEST=""
CURRENT_INTERVAL=30

while true; do
  manifest=$(fetch_manifest) || {
    sleep "$CURRENT_INTERVAL"
    continue
  }

  if [ "$manifest" = "__UNCHANGED__" ]; then
    manifest="$CURRENT_MANIFEST"
  else
    CURRENT_MANIFEST="$manifest"
    CURRENT_INTERVAL=$(get_manifest_interval "$manifest")
    echo "$(date -Iseconds) Manifest v$(get_manifest_version "$manifest"), Intervall: ${CURRENT_INTERVAL}s, Modus: ${ACTIVE_MODE}"
  fi

  version=$(get_manifest_version "$manifest")
  results=()
  while IFS=$'\t' read -r id cmd timeout; do
    [ -z "$id" ] && continue
    results+=("$(run_collector "$id" "$cmd" "$timeout")")
  done < <(parse_collectors "$manifest")

  if [ ${#results[@]} -gt 0 ]; then
    report=$(build_report "${version:-0}" "${results[@]}")
    send_report "$report" &
  fi

  sleep "$CURRENT_INTERVAL"
done
