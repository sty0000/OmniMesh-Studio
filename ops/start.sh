#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd

sudo systemctl start "$SERVICE_VLLM"
sudo systemctl start "$SERVICE_GATEWAY"
sudo systemctl start "$SERVICE_ALERT_TIMER"

log "started: $SERVICE_VLLM, $SERVICE_GATEWAY, $SERVICE_ALERT_TIMER"

