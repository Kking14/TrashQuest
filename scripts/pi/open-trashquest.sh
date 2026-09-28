#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  printf '%s\n' 'Open the website from the Pi desktop, not an SSH-only session.' >&2
  exit 1
fi
exec xdg-open http://127.0.0.1:5173/
