#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
notice() {
  printf '%s\n' "$*"
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v notify-send >/dev/null 2>&1; then
    notify-send TrashQuest "$*" || true
  fi
}
wait_for() {
  local name="$1" url="$2" attempts="$3"
  for ((i=0; i<attempts; i++)); do
    if "$ROOT/.venv/bin/python" - "$url" <<'PY' >/dev/null 2>&1
import sys
from urllib.request import urlopen
with urlopen(sys.argv[1], timeout=2) as response:
    if response.status != 200:
        raise RuntimeError(response.status)
PY
    then
      if ! systemctl --user is-active --quiet "trashquest-${name,,}.service"; then
        notice "$name responded, but its TrashQuest service is not running. Check for another process on that port."
        return 1
      fi
      notice "$name is ready."
      return 0
    fi
    sleep 1
  done
  notice "$name did not become ready. Check its systemd user-service log."
  return 1
}
if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  notice 'Python .venv is missing. Install station requirements first.'
  exit 1
fi
if ! systemctl --user start trashquest-backend.service; then
  notice 'Backend could not start. Run scripts/pi/setup-autostart.sh once.'
  exit 1
fi
wait_for Backend http://127.0.0.1:5001/api/health 40
systemctl --user start trashquest-frontend.service
wait_for Frontend http://127.0.0.1:5173/ 40
systemctl --user start trashquest-gateway.service
wait_for Gateway http://127.0.0.1:8765/health 100
notice 'Backend, frontend, and camera/ESP32 gateway are running.'
if [[ "${1:-}" == '--open' ]]; then
  "$ROOT/scripts/pi/open-trashquest.sh"
fi
