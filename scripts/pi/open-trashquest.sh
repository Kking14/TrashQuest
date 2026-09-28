#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  printf '%s\n' 'Open the website from the Pi desktop, not an SSH-only session.' >&2
  exit 1
fi
for _ in {1..30}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1/ >/dev/null; then
    exec xdg-open http://127.0.0.1/
  fi
  sleep 1
done
printf '%s\n' 'Frontend did not respond at http://127.0.0.1/.' >&2
exit 1
