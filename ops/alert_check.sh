#!/usr/bin/env bash

set -euo pipefail

ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
ALERT_TIMEOUT_SECONDS="${ALERT_TIMEOUT_SECONDS:-5}"
METRICS_URL="${METRICS_URL:-http://127.0.0.1:3000/internal/metrics}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"

THRESHOLD_API_429_RATIO="${THRESHOLD_API_429_RATIO:-0.05}"
THRESHOLD_API_5XX_RATIO="${THRESHOLD_API_5XX_RATIO:-0.01}"
THRESHOLD_QUEUE_CONTINUOUS_MS="${THRESHOLD_QUEUE_CONTINUOUS_MS:-300000}"

HEALTH_FAIL_WINDOW_FILE="${HEALTH_FAIL_WINDOW_FILE:-/var/tmp/qwen-health-fail.count}"
HEALTH_FAIL_THRESHOLD="${HEALTH_FAIL_THRESHOLD:-3}"

if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
  exit 0
fi

send_alert() {
  local message="$1"
  curl -sS -m "$ALERT_TIMEOUT_SECONDS" -X POST "$ALERT_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"${message}\"}}" >/dev/null || true
}

health_ok=0
if curl -fsS -m "$ALERT_TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null; then
  health_ok=1
fi

if [[ "$health_ok" -eq 1 ]]; then
  echo 0 >"$HEALTH_FAIL_WINDOW_FILE"
else
  fails=0
  if [[ -f "$HEALTH_FAIL_WINDOW_FILE" ]]; then
    fails="$(cat "$HEALTH_FAIL_WINDOW_FILE" 2>/dev/null || echo 0)"
  fi
  fails=$((fails + 1))
  echo "$fails" >"$HEALTH_FAIL_WINDOW_FILE"
  if (( fails >= HEALTH_FAIL_THRESHOLD )); then
    send_alert "[Qwen Alert] health failed ${fails} times continuously"
  fi
fi

metrics_json="$(curl -fsS -m "$ALERT_TIMEOUT_SECONDS" "$METRICS_URL" || true)"
if [[ -z "$metrics_json" ]]; then
  send_alert "[Qwen Alert] metrics endpoint unreachable: ${METRICS_URL}"
  exit 0
fi

alert_message="$(python3 - "$metrics_json" "$THRESHOLD_API_429_RATIO" "$THRESHOLD_API_5XX_RATIO" "$THRESHOLD_QUEUE_CONTINUOUS_MS" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
th_429 = float(sys.argv[2])
th_5xx = float(sys.argv[3])
th_queue = float(sys.argv[4])

metrics = payload.get("metrics", {})
rates = metrics.get("rates", {})
queue = metrics.get("queue", {})

alerts = []
api_429 = float(rates.get("api429Ratio", 0.0))
api_5xx = float(rates.get("api5xxRatio", 0.0))
queue_ms = float(queue.get("currentContinuousMs", 0.0))

if api_429 > th_429:
    alerts.append(f"429 ratio high: {api_429:.4f} > {th_429:.4f}")
if api_5xx > th_5xx:
    alerts.append(f"5xx ratio high: {api_5xx:.4f} > {th_5xx:.4f}")
if queue_ms > th_queue:
    alerts.append(f"queue continuous high: {int(queue_ms)}ms > {int(th_queue)}ms")

print("; ".join(alerts))
PY
)"

if [[ -n "$alert_message" ]]; then
  send_alert "[Qwen Alert] $alert_message"
fi
