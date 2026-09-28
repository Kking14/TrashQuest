#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
notice() {
  printf '%s\n' "$*"
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v notify-send >/dev/null 2>&1; then
    notify-send TrashQuest "$*" || true
  fi
}
# Avoid interrupting motor movement or an unfinished disposal.
state="$("$ROOT/.venv/bin/python" -c 'import json, urllib.request; print(json.load(urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=2)).get("workflowState", "UNKNOWN"))' 2>/dev/null || true)"
if [[ -n "$state" && "$state" != 'IDLE' ]]; then
  notice "Station is $state. Wait until sorting finishes before stopping."
  exit 1
fi
if [[ -z "$state" ]] && systemctl --user is-active --quiet trashquest-gateway.service; then
  notice 'Gateway is running, but its safety state is unavailable. Check the station before stopping it.'
  exit 1
fi
systemctl --user stop trashquest-gateway.service
notice 'Station gateway stopped. The Vercel website remains online.'
