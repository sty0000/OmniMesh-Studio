#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd

sudo systemctl --no-pager --full status "$SERVICE_VLLM" "$SERVICE_GATEWAY" "$SERVICE_ALERT_TIMER" || true

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
