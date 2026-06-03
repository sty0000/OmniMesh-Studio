#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd

sudo systemctl restart "$SERVICE_VLLM"
sudo systemctl restart "$SERVICE_GATEWAY"
sudo systemctl restart "$SERVICE_ALERT_TIMER"

log "restarted: $SERVICE_VLLM, $SERVICE_GATEWAY, $SERVICE_ALERT_TIMER"
log "showing current status"
bash "$SCRIPT_DIR/status.sh"