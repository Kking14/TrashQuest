#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [[ "$ROOT" =~ [[:space:]] ]]; then
  printf '%s\n' 'The project path must not contain spaces.' >&2
  exit 1
fi
for path in "$ROOT/.venv/bin/python" "$ROOT/.env.station"; do
  if [[ ! -e "$path" ]]; then
    printf 'Missing prerequisite: %s\n' "$path" >&2
    exit 1
  fi
done

# The backend is deployed on Vercel. A leftover localhost URL in .env.station
# would make the gateway fail when the old local backend is not running.
backend_url="$(sed -n 's/^TQ_BACKEND_URL=//p' "$ROOT/.env.station" | head -n 1 | tr -d '\r')"
if [[ -z "$backend_url" || "$backend_url" == *'127.0.0.1'* || "$backend_url" == *'localhost'* ]]; then
  printf '%s\n' 'Set TQ_BACKEND_URL in .env.station to your deployed Vercel API URL first.' >&2
  exit 1
fi

# Avoid competing with an older root/system service or a manually started
# gateway for the ESP32 serial port and camera.
if systemctl is-active --quiet trashquest-gateway.service; then
  printf '%s\n' 'A system-wide trashquest-gateway service is active. Stop/disable it before this setup.' >&2
  exit 1
fi
state="$("$ROOT/.venv/bin/python" -c 'import json, urllib.request; print(json.load(urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=2)).get("workflowState", "UNKNOWN"))' 2>/dev/null || true)"
if [[ -n "$state" && "$state" != 'IDLE' ]]; then
  printf 'Station is %s. Finish the disposal before setup.\n' "$state" >&2
  exit 1
fi
if [[ -n "$state" ]] && ! systemctl --user is-active --quiet trashquest-gateway.service; then
  printf '%s\n' 'A manually started gateway is using port 8765. Stop it before setup.' >&2
  exit 1
fi
if [[ -z "$state" ]] && systemctl --user is-active --quiet trashquest-gateway.service; then
  printf '%s\n' 'The gateway is running, but its safety state is unavailable. Check it before setup.' >&2
  exit 1
fi

install -d -m 0755 "$HOME/.config/systemd/user" "$HOME/.config/autostart" "$HOME/Desktop" \
  "$ROOT/.runtime/matplotlib" "$ROOT/.runtime/ultralytics"
cat >"$HOME/.config/systemd/user/trashquest-gateway.service" <<EOF
[Unit]
Description=TrashQuest camera, AI and ESP32 gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PYTHONUNBUFFERED=1
Environment=MPLCONFIGDIR=$ROOT/.runtime/matplotlib
Environment=YOLO_CONFIG_DIR=$ROOT/.runtime/ultralytics
ExecStart=$ROOT/.venv/bin/python $ROOT/station_gateway.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

chmod +x "$ROOT/scripts/pi/start-trashquest.sh" "$ROOT/scripts/pi/stop-trashquest.sh" "$ROOT/scripts/pi/open-trashquest.sh"
cat >"$HOME/Desktop/TrashQuest Start.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Start
Comment=Start station hardware and open the deployed website
Exec=$ROOT/scripts/pi/start-trashquest.sh --open
Icon=media-playback-start
Terminal=false
EOF
cat >"$HOME/Desktop/TrashQuest Stop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Stop
Comment=Stop station hardware after sorting is finished
Exec=$ROOT/scripts/pi/stop-trashquest.sh
Icon=media-playback-stop
Terminal=false
EOF
cat >"$HOME/Desktop/TrashQuest Open.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Open
Comment=Open the deployed TrashQuest website
Exec=$ROOT/scripts/pi/open-trashquest.sh
Icon=web-browser
Terminal=false
EOF
cat >"$HOME/.config/autostart/trashquest-open.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Open at Login
Exec=$ROOT/scripts/pi/open-trashquest.sh
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
chmod +x "$HOME/Desktop"/TrashQuest\ *.desktop "$HOME/.config/autostart/trashquest-open.desktop"
if command -v gio >/dev/null 2>&1; then
  for launcher in "$HOME/Desktop"/TrashQuest\ *.desktop; do
    gio set "$launcher" metadata::trusted true >/dev/null 2>&1 || true
  done
fi

systemctl --user daemon-reload
systemctl --user enable trashquest-gateway.service
systemctl --user restart trashquest-gateway.service
printf '\n%s\n' 'Pi Start/Stop/Open icons are ready. The gateway starts on desktop login.'
printf '%s\n' 'The default browser opens the deployed website at desktop login.'
printf '%s\n' 'Check gateway errors with: journalctl --user -u trashquest-gateway -n 80 --no-pager'
