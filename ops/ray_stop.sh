#!/usr/bin/env bash

set -euo pipefail

RAY_DRY_RUN="${RAY_DRY_RUN:-0}"
cmd=(ray stop --force)

if [[ "$RAY_DRY_RUN" == "1" ]]; then
  printf 'DRY RUN:'
  printf ' %q' "${cmd[@]}"
  printf '\n'
  exit 0
fi

if ! command -v ray >/dev/null 2>&1; then
  echo "ray command not found. Activate the vLLM/Ray Python environment first." >&2
  exit 127
fi

exec "${cmd[@]}"