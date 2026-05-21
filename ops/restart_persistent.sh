#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd
need_cmd ps
need_cmd rsync
need_cmd systemctl

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash ops/restart_persistent.sh"
  exit 1
fi

find_listener_pids() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null \
      | grep -E "[[:space:]:]${port}[[:space:]]" \
      | grep -o 'pid=[0-9]\+' \
      | sed 's/pid=//' \
      | sort -u
    return 0
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "TCP:${port}" -sTCP:LISTEN 2>/dev/null | sort -u
    return 0
  fi

  echo "Neither ss nor lsof is available; cannot inspect port ${port}" >&2
  exit 1
}

stop_manual_listener() {
  local port="$1"
  local expected_pattern="$2"
  local label="$3"
  local pids

  mapfile -t pids < <(find_listener_pids "$port")
  if [[ ${#pids[@]} -eq 0 ]]; then
    log "no listener on port ${port}"
    return 0
  fi

  for pid in "${pids[@]}"; do
    [[ -n "$pid" ]] || continue
    local cmdline
    cmdline="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [[ -z "$cmdline" ]]; then
      continue
    fi

    if [[ "$cmdline" != *"$expected_pattern"* ]]; then
      echo "Port ${port} is occupied by an unexpected process:" >&2
      echo "  PID ${pid}: ${cmdline}" >&2
      echo "Refusing to kill it automatically. Please stop it manually, then rerun." >&2
      exit 2
    fi

    log "stopping manual ${label} process on port ${port}: PID ${pid}"
    kill "$pid" || true
  done

  sleep 2

  mapfile -t pids < <(find_listener_pids "$port")
  for pid in "${pids[@]}"; do
    [[ -n "$pid" ]] || continue
    local cmdline
    cmdline="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [[ "$cmdline" == *"$expected_pattern"* ]]; then
      log "force stopping stubborn ${label} process on port ${port}: PID ${pid}"
      kill -9 "$pid" || true
    fi
  done
}

log "stopping existing systemd units"
systemctl stop "$SERVICE_ALERT_TIMER" || true
systemctl stop "$SERVICE_GATEWAY" || true
systemctl stop "$SERVICE_VLLM" || true

log "cleaning up old manual listeners if present"
stop_manual_listener 3000 "gateway.server.js" "gateway"
stop_manual_listener 8000 "vllm.entrypoints.openai.api_server" "vLLM"

log "reinstalling persistent service assets"
bash "$SCRIPT_DIR/install_systemd.sh"

log "starting persistent services"
bash "$SCRIPT_DIR/start.sh"

log "showing current status"
bash "$SCRIPT_DIR/status.sh"
