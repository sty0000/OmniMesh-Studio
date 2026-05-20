#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash ops/install_systemd.sh"
  exit 1
fi

install -d -m 755 /opt/qwen-web /etc/qwen-web /var/log/qwen-web

rsync -a --delete "$ROOT_DIR/" /opt/qwen-web/ \
  --exclude .git --exclude node_modules --exclude coverage --exclude '*.log'

safe_copy_if_missing /opt/qwen-web/deploy/env/gateway.env.example /etc/qwen-web/gateway.env
safe_copy_if_missing /opt/qwen-web/deploy/env/vllm.env.example /etc/qwen-web/vllm.env
safe_copy_if_missing /opt/qwen-web/deploy/env/alert.env.example /etc/qwen-web/alert.env

install -m 644 /opt/qwen-web/deploy/systemd/qwen-vllm.service /etc/systemd/system/qwen-vllm.service
install -m 644 /opt/qwen-web/deploy/systemd/qwen-gateway.service /etc/systemd/system/qwen-gateway.service
install -m 644 /opt/qwen-web/deploy/systemd/qwen-alert.service /etc/systemd/system/qwen-alert.service
install -m 644 /opt/qwen-web/deploy/systemd/qwen-alert.timer /etc/systemd/system/qwen-alert.timer

systemctl daemon-reload
systemctl enable qwen-vllm.service qwen-gateway.service qwen-alert.timer

log "Install complete. Edit /etc/qwen-web/*.env then run: bash /opt/qwen-web/ops/start.sh"

