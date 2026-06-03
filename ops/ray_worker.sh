#!/usr/bin/env bash

set -euo pipefail

ENV_DIR="${QWEN_WEB_ENV_DIR:-/etc/qwen-web}"
RAY_ENV="$ENV_DIR/ray.env"
if [[ -f "$RAY_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$RAY_ENV"
  set +a
fi

RAY_HEAD_IP="${RAY_HEAD_IP:-192.168.100.1}"
RAY_WORKER_IP="${RAY_WORKER_IP:-192.168.100.2}"
RAY_PORT="${RAY_PORT:-6379}"
RAY_NODE_MANAGER_PORT="${RAY_NODE_MANAGER_PORT:-8076}"
RAY_OBJECT_MANAGER_PORT="${RAY_OBJECT_MANAGER_PORT:-8077}"
RAY_RUNTIME_ENV_AGENT_PORT="${RAY_RUNTIME_ENV_AGENT_PORT:-8078}"
RAY_MIN_WORKER_PORT="${RAY_MIN_WORKER_PORT:-10002}"
RAY_MAX_WORKER_PORT="${RAY_MAX_WORKER_PORT:-10100}"
RAY_NUM_GPUS="${RAY_NUM_GPUS:-1}"
RAY_TEMP_DIR="${RAY_TEMP_DIR:-/tmp/ray}"
RAY_DRY_RUN="${RAY_DRY_RUN:-0}"

require_ray() {
  if ! command -v ray >/dev/null 2>&1; then
    echo "ray command not found. Activate the vLLM/Ray Python environment first." >&2
    exit 127
  fi
}

print_summary() {
  echo "Ray worker configuration:"
  echo "  env_file=${RAY_ENV}"
  echo "  head=${RAY_HEAD_IP}:${RAY_PORT}"
  echo "  worker=${RAY_WORKER_IP}"
  echo "  node_manager=${RAY_NODE_MANAGER_PORT} object_manager=${RAY_OBJECT_MANAGER_PORT} runtime_env_agent=${RAY_RUNTIME_ENV_AGENT_PORT}"
  echo "  worker_ports=${RAY_MIN_WORKER_PORT}-${RAY_MAX_WORKER_PORT} num_gpus=${RAY_NUM_GPUS} temp_dir=${RAY_TEMP_DIR}"
}

cmd=(
  ray start
  --address="$RAY_HEAD_IP:$RAY_PORT"
  --node-ip-address="$RAY_WORKER_IP"
  --node-manager-port="$RAY_NODE_MANAGER_PORT"
  --object-manager-port="$RAY_OBJECT_MANAGER_PORT"
  --runtime-env-agent-port="$RAY_RUNTIME_ENV_AGENT_PORT"
  --min-worker-port="$RAY_MIN_WORKER_PORT"
  --max-worker-port="$RAY_MAX_WORKER_PORT"
  --num-gpus="$RAY_NUM_GPUS"
  --temp-dir="$RAY_TEMP_DIR"
  --block
)

print_summary
if [[ "$RAY_DRY_RUN" == "1" ]]; then
  printf 'DRY RUN:'
  printf ' %q' "${cmd[@]}"
  printf '\n'
  exit 0
fi

require_ray
exec "${cmd[@]}"