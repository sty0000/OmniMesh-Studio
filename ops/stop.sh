#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd

sudo systemctl stop "$SERVICE_ALERT_TIMER" || true
sudo systemctl stop "$SERVICE_GATEWAY" || true
sudo systemctl stop "$SERVICE_VLLM" || true

log "stopped services"

