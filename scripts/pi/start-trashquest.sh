#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
notice() {
  printf '%s\n' "$*"
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v notify-send >/dev/null 2>&1; then
    notify-send TrashQuest "$*" || true
  fi
}
# Setup grants passwordless access only to these named services.
if ! sudo -n systemctl start nginx.service; then
  notice 'Frontend could not start. Run scripts/pi/setup-autostart.sh first.'
  exit 1
fi
if ! sudo -n systemctl start trashquest-backend.service; then
  notice 'Backend could not start. Check its service log.'
  exit 1
fi
if ! sudo -n systemctl start trashquest-gateway.service; then
  notice 'Gateway could not start. Check its service log.'
  exit 1
fi
notice 'TrashQuest started. AI and camera loading may take a moment.'
if [[ "${1:-}" == '--open' ]]; then
  "$ROOT/scripts/pi/open-trashquest.sh"
fi
