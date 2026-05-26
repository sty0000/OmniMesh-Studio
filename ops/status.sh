#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd
need_cmd curl

sudo systemctl --no-pager --full status "$SERVICE_VLLM" "$SERVICE_GATEWAY" "$SERVICE_ALERT_TIMER" || true

wait_for_gateway() {
  local attempts="${STATUS_WAIT_ATTEMPTS:-20}"
  local sleep_seconds="${STATUS_WAIT_INTERVAL_SECONDS:-2}"
  local url="http://127.0.0.1:3000/health"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      if (( attempt > 1 )); then
        log "gateway became reachable after ${attempt} checks"
      fi
      return 0
    fi

    if (( attempt == 1 )); then
      log "waiting for gateway health endpoint: ${url}"
    fi

    sleep "$sleep_seconds"
  done

  log "gateway health endpoint did not become reachable within $((attempts * sleep_seconds))s"
  return 1
}

echo
wait_for_gateway || true

echo
echo "--- health ---"
curl -fsS http://127.0.0.1:3000/health || true
echo
echo "--- ready ---"
curl -fsS http://127.0.0.1:3000/ready || true
echo
echo "--- metrics ---"
curl -fsS http://127.0.0.1:3000/internal/metrics || true
echo
