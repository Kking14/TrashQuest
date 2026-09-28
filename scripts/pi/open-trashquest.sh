#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  printf '%s\n' 'Open the website from the Pi desktop, not an SSH-only session.' >&2
  exit 1
fi
exec xdg-open https://trashquest-web.vercel.app/
