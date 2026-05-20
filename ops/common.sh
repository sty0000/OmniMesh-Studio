#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT_DIR

SERVICE_VLLM="qwen-vllm.service"
SERVICE_GATEWAY="qwen-gateway.service"
SERVICE_ALERT_TIMER="qwen-alert.timer"

log() {
  echo "[$(date '+%F %T')] $*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Command not found: $1" >&2
    exit 1
  }
}

check_systemd() {
  need_cmd systemctl
}

safe_copy_if_missing() {
  local source="$1"
  local target="$2"
  if [[ ! -f "$target" ]]; then
    cp "$source" "$target"
    log "created: $target"
  fi
}

