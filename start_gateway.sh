#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

: "${TEAM_API_KEY:=change-me-in-production}"
: "${GATEWAY_HOST:=0.0.0.0}"
: "${GATEWAY_PORT:=3000}"
: "${VLLM_BASE:=http://127.0.0.1:8000}"

: "${RATE_LIMIT_RPS:=5}"
: "${RATE_LIMIT_BURST:=10}"
: "${MAX_CONCURRENT_PER_CLIENT:=2}"
: "${MAX_GLOBAL_INFLIGHT:=32}"
: "${MAX_QUEUE_SIZE:=128}"
: "${QUEUE_WAIT_MS:=20000}"

LOG_FILE="${LOG_FILE:-gateway.log}"

echo "[Gateway] Launching on ${GATEWAY_HOST}:${GATEWAY_PORT}" 
echo "[Gateway] Upstream: ${VLLM_BASE}"
echo "[Gateway] Logs: ${LOG_FILE}"

nohup env \
  TEAM_API_KEY="$TEAM_API_KEY" \
  GATEWAY_HOST="$GATEWAY_HOST" \
  GATEWAY_PORT="$GATEWAY_PORT" \
  VLLM_BASE="$VLLM_BASE" \
  RATE_LIMIT_RPS="$RATE_LIMIT_RPS" \
  RATE_LIMIT_BURST="$RATE_LIMIT_BURST" \
  MAX_CONCURRENT_PER_CLIENT="$MAX_CONCURRENT_PER_CLIENT" \
  MAX_GLOBAL_INFLIGHT="$MAX_GLOBAL_INFLIGHT" \
  MAX_QUEUE_SIZE="$MAX_QUEUE_SIZE" \
  QUEUE_WAIT_MS="$QUEUE_WAIT_MS" \
  node gateway.server.js >"$LOG_FILE" 2>&1 &

echo "[Gateway] Started. PID: $!"

