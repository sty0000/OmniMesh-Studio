#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

ENV_DIR="${QWEN_WEB_ENV_DIR:-/etc/qwen-web}"
GATEWAY_ENV="$ENV_DIR/gateway.env"
GATEWAY_LOCAL_URL="${GATEWAY_LOCAL_URL:-http://127.0.0.1:3000}"
SMOKE_MODE="${1:-auto}"
SMOKE_PROMPT="${SMOKE_PROMPT:-smoke test: reply with ok}"
SMOKE_IMAGE="${SMOKE_IMAGE:-}"

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

load_env_file "$GATEWAY_ENV"

AUTH_HEADER=()
if [[ -n "${TEAM_API_KEY:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${TEAM_API_KEY}")
fi

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

print_section() {
  echo
  echo "=== $* ==="
}

curl_json() {
  local url="$1"
  shift
  curl -fsS "$url" "$@"
  echo
}

run_status_snapshot() {
  print_section "status snapshot"
  bash "$SCRIPT_DIR/status.sh" || true
}

run_models_probe() {
  print_section "models probe"
  curl_json "${GATEWAY_LOCAL_URL}/v1/models" "${AUTH_HEADER[@]}" || true
}

run_text_probe() {
  print_section "chat text probe"
  local prompt
  prompt="$(printf '%s' "$SMOKE_PROMPT" | json_escape)"
  curl_json "${GATEWAY_LOCAL_URL}/v1/chat/completions" \
    "${AUTH_HEADER[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${SMOKE_MODEL:-qwen}\",\"messages\":[{\"role\":\"user\",\"content\":\"${prompt}\"}],\"max_tokens\":32}"
}

run_image_probe() {
  if [[ -z "$SMOKE_IMAGE" ]]; then
    return 0
  fi
  if [[ ! -f "$SMOKE_IMAGE" ]]; then
    echo "SMOKE_IMAGE not found: $SMOKE_IMAGE" >&2
    return 1
  fi
  print_section "chat image probe"
  local mime image_data
  mime="$(file --brief --mime-type "$SMOKE_IMAGE" 2>/dev/null || echo image/jpeg)"
  image_data="$(base64 -w 0 "$SMOKE_IMAGE")"
  curl_json "${GATEWAY_LOCAL_URL}/v1/chat/completions" \
    "${AUTH_HEADER[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${SMOKE_MODEL:-qwen}\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:${mime};base64,${image_data}\"}},{\"type\":\"text\",\"text\":\"describe this image briefly\"}]}],\"max_tokens\":128}"
}

run_ray_dry_run() {
  print_section "ray dry-run"
  RAY_DRY_RUN=1 QWEN_WEB_ENV_DIR="$ENV_DIR" bash "$SCRIPT_DIR/ray_head.sh" || true
  RAY_DRY_RUN=1 QWEN_WEB_ENV_DIR="$ENV_DIR" bash "$SCRIPT_DIR/ray_worker.sh" || true
  RAY_DRY_RUN=1 bash "$SCRIPT_DIR/ray_stop.sh" || true
}

case "$SMOKE_MODE" in
  auto|single|replica)
    run_status_snapshot
    run_models_probe
    run_text_probe
    run_image_probe
    ;;
  ray-dry-run)
    run_ray_dry_run
    ;;
  all)
    run_status_snapshot
    run_models_probe
    run_text_probe
    run_image_probe
    run_ray_dry_run
    ;;
  *)
    echo "Usage: $0 [auto|single|replica|ray-dry-run|all]" >&2
    exit 2
    ;;
esac
