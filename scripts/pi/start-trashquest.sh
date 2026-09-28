#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
notice() {
  printf '%s\n' "$*"
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v notify-send >/dev/null 2>&1; then
    notify-send TrashQuest "$*" || true
  fi
}
# The frontend and backend are hosted on Vercel; only the local hardware
# gateway runs on the Pi. This user service needs no password at the screen.
if ! systemctl --user start trashquest-gateway.service; then
  notice 'Gateway could not start. Run scripts/pi/setup-autostart.sh once from a terminal.'
  exit 1
fi
notice 'Station gateway started. AI and camera loading may take a moment.'
if [[ "${1:-}" == '--open' ]]; then
  "$ROOT/scripts/pi/open-trashquest.sh"
fi
