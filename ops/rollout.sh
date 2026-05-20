#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd
need_cmd curl
need_cmd rsync

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash ops/rollout.sh"
  exit 1
fi

BACKUP_ROOT="/opt/qwen-web-backups"
TARGET_DIR="/opt/qwen-web"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"

mkdir -p "$BACKUP_ROOT"

log "preflight: checking service readiness"
if ! curl -fsS http://127.0.0.1:3000/ready >/dev/null; then
  log "warning: gateway readiness check failed before rollout"
fi

log "backup current release to: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
rsync -a --delete "$TARGET_DIR/" "$BACKUP_DIR/"

log "sync new code to target"
rsync -a --delete "$ROOT_DIR/" "$TARGET_DIR/" \
  --exclude .git --exclude node_modules --exclude coverage --exclude '*.log'

log "safe restart gateway"
if systemctl restart "$SERVICE_GATEWAY"; then
  if curl -fsS http://127.0.0.1:3000/ready >/dev/null; then
    log "rollout success"
    exit 0
  fi
fi

log "rollout failed, restoring previous release"
rsync -a --delete "$BACKUP_DIR/" "$TARGET_DIR/"
systemctl restart "$SERVICE_GATEWAY"
if curl -fsS http://127.0.0.1:3000/ready >/dev/null; then
  log "rollback success"
else
  log "rollback failed: manual intervention required"
  exit 2
fi
