#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd

sudo systemctl restart "$SERVICE_VLLM"
sudo systemctl restart "$SERVICE_GATEWAY"

log "restarted: $SERVICE_VLLM and $SERVICE_GATEWAY"

