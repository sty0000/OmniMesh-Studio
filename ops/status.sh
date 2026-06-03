#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

check_systemd
need_cmd curl

ENV_DIR="${QWEN_WEB_ENV_DIR:-/etc/qwen-web}"
GATEWAY_ENV="$ENV_DIR/gateway.env"
VLLM_ENV="$ENV_DIR/vllm.env"
RAY_ENV="$ENV_DIR/ray.env"
GATEWAY_LOCAL_URL="${GATEWAY_LOCAL_URL:-http://127.0.0.1:3000}"

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
load_env_file "$VLLM_ENV"
load_env_file "$RAY_ENV"

detect_mode() {
  if [[ "${EXTRA_VLLM_ARGS:-}" == *"distributed-executor-backend ray"* ]] || [[ -n "${RAY_HEAD_IP:-}" ]]; then
    echo "ray"
  elif [[ -n "${VLLM_BASES:-}" ]]; then
    echo "replica"
  else
    echo "single"
  fi
}

print_mode_hints() {
  local mode="$1"
  local upstream_count=0
  if [[ -n "${VLLM_BASES:-}" ]]; then
    IFS=',' read -r -a upstream_items <<< "${VLLM_BASES}"
    upstream_count="${#upstream_items[@]}"
  elif [[ -n "${VLLM_BASE:-}" ]]; then
    upstream_count=1
  fi

  echo "--- mode checklist ---"
  case "$mode" in
    single)
      echo "single: expect VLLM_BASE=http://127.0.0.1:8000 and VLLM_BASES empty"
      echo "single: validate /ready, /internal/metrics, and this status output"
      ;;
    replica)
      echo "replica: upstream_count=${upstream_count}; inspect upstream table for ready/circuit, ok%, avg_ms, last_error"
      echo "replica: stop one upstream to verify failover/circuit; restore it to verify it rejoins"
      ;;
    ray)
      echo "ray: head=${RAY_HEAD_IP:-unset}:${RAY_PORT:-6379} worker=${RAY_WORKER_IP:-unset} ports=${RAY_MIN_WORKER_PORT:-10002}-${RAY_MAX_WORKER_PORT:-10100}"
      echo "ray: vLLM args must include distributed-executor-backend ray; restart order is ray -> vLLM -> gateway"
      echo "ray: dry-run with RAY_DRY_RUN=1 ./ops/ray_head.sh && ./ops/ray_worker.sh; stop with ./ops/ray_stop.sh"
      ;;
  esac
  echo
}

print_env_summary() {
  local mode
  mode="$(detect_mode)"
  echo "--- deployment ---"
  echo "mode: ${mode}"
  echo "env_dir: ${ENV_DIR}"
  echo "gateway: ${GATEWAY_LOCAL_URL}"
  echo "VLLM_BASE: ${VLLM_BASE:-}"
  echo "VLLM_BASES: ${VLLM_BASES:-}"
  echo "EXTRA_VLLM_ARGS: ${EXTRA_VLLM_ARGS:-}"
  echo "RAY_HEAD_IP: ${RAY_HEAD_IP:-}"
  echo "RAY_WORKER_IP: ${RAY_WORKER_IP:-}"
  echo "RAY_PORT: ${RAY_PORT:-6379}"
  echo "RAY_DASHBOARD_PORT: ${RAY_DASHBOARD_PORT:-8265}"
  echo "RAY_WORKER_PORTS: ${RAY_MIN_WORKER_PORT:-10002}-${RAY_MAX_WORKER_PORT:-10100}"
  echo "NCCL_SOCKET_IFNAME: ${NCCL_SOCKET_IFNAME:-}"
  echo "NCCL_IB_HCA: ${NCCL_IB_HCA:-}"
  echo "NCCL_IB_GID_INDEX: ${NCCL_IB_GID_INDEX:-}"
  echo
  print_mode_hints "$mode"
}

wait_for_gateway() {
  local attempts="${STATUS_WAIT_ATTEMPTS:-20}"
  local sleep_seconds="${STATUS_WAIT_INTERVAL_SECONDS:-2}"
  local url="${GATEWAY_LOCAL_URL}/health"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      if (( attempt > 1 )); then
        log "gateway became reachable after ${attempt} checks"
      fi
      return 0
    fi

    if (( attempt == 1 )); then
      log "waiting for gateway health endpoint: ${url}"
    fi

    sleep "$sleep_seconds"
  done

  log "gateway health endpoint did not become reachable within $((attempts * sleep_seconds))s"
  return 1
}

print_upstream_summary() {
  local metrics_file="$1"
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  python3 - "$metrics_file" <<'PY'
import json
import sys
from datetime import datetime

path = sys.argv[1]
try:
    with open(path, 'r', encoding='utf-8') as fh:
        payload = json.load(fh)
except Exception as exc:
    print(f"upstream summary unavailable: {exc}")
    raise SystemExit(0)

upstreams = payload.get('metrics', {}).get('upstreams') or []
if not upstreams:
    print('upstreams: none reported')
    raise SystemExit(0)

print('--- upstreams ---')
print(f"{'base':<34} {'state':<10} {'ok%':>7} {'try':>5} {'ok':>5} {'fail':>5} {'avg_ms':>8} {'last_error'}")
for item in upstreams:
    base = item.get('base', '')
    state = 'circuit' if item.get('circuitOpen') else 'ready'
    rate = item.get('successRate')
    rate_text = '-' if rate is None else f"{rate * 100:.1f}"
    latency = item.get('averageLatencyMs')
    latency_text = '-' if latency is None else str(latency)
    last_error = item.get('lastError') or ''
    if len(base) > 33:
        base = base[:30] + '...'
    if len(last_error) > 44:
        last_error = last_error[:41] + '...'
    print(f"{base:<34} {state:<10} {rate_text:>7} {item.get('attempts', 0):>5} {item.get('successes', 0):>5} {item.get('failures', 0):>5} {latency_text:>8} {last_error}")
PY
  echo
}

print_env_summary
sudo systemctl --no-pager --full status "$SERVICE_VLLM" "$SERVICE_GATEWAY" "$SERVICE_ALERT_TIMER" || true

echo
wait_for_gateway || true

echo
echo "--- health ---"
curl -fsS "${GATEWAY_LOCAL_URL}/health" || true
echo
echo "--- ready ---"
curl -fsS "${GATEWAY_LOCAL_URL}/ready" || true
echo

metrics_tmp="$(mktemp)"
if curl -fsS "${GATEWAY_LOCAL_URL}/internal/metrics" -o "$metrics_tmp"; then
  print_upstream_summary "$metrics_tmp"
  echo "--- metrics ---"
  cat "$metrics_tmp"
else
  echo "--- metrics ---"
  cat "$metrics_tmp" 2>/dev/null || true
fi
rm -f "$metrics_tmp"
echo
