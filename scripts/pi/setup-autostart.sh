#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [[ "$ROOT" =~ [[:space:]] ]]; then
  printf '%s\n' 'The project path must not contain spaces.' >&2
  exit 1
fi
for path in "$ROOT/.venv/bin/python" "$ROOT/.env.station" "$ROOT/Backend/.env" \
            "$ROOT/Backend/node_modules" "$ROOT/Frontend/node_modules"; do
  if [[ ! -e "$path" ]]; then
    printf 'Missing prerequisite: %s\n' "$path" >&2
    exit 1
  fi
done

NPM="$(command -v npm || true)"
NODE="$(command -v node || true)"
if [[ -z "$NPM" || -z "$NODE" ]]; then
  printf '%s\n' 'Node.js and npm must be installed before setup.' >&2
  exit 1
fi
NODE_PATH="$(dirname "$NODE"):$(dirname "$NPM"):/usr/local/bin:/usr/bin:/bin"

port_busy() {
  "$ROOT/.venv/bin/python" - "$1" <<'PY' >/dev/null 2>&1
import socket, sys
with socket.socket() as sock:
    sys.exit(0 if sock.connect_ex(('127.0.0.1', int(sys.argv[1]))) == 0 else 1)
PY
}
for entry in backend:5001 frontend:5173 gateway:8765; do
  service="${entry%%:*}"
  port="${entry##*:}"
  if port_busy "$port" && ! systemctl --user is-active --quiet "trashquest-$service.service"; then
    printf 'Port %s is already used by another process. Stop it before setup.\n' "$port" >&2
    exit 1
  fi
done

# Avoid competing with an older root/system service for the ESP32 and camera.
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
cat >"$HOME/.config/systemd/user/trashquest-backend.service" <<EOF
[Unit]
Description=TrashQuest local backend
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/Backend
Environment=NODE_ENV=production
Environment=PATH=$NODE_PATH
ExecStart=$NPM run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
cat >"$HOME/.config/systemd/user/trashquest-frontend.service" <<EOF
[Unit]
Description=TrashQuest local frontend
After=trashquest-backend.service

[Service]
Type=simple
WorkingDirectory=$ROOT/Frontend
Environment=PATH=$NODE_PATH
ExecStart=$NPM run dev -- --host 127.0.0.1 --strictPort
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
cat >"$HOME/.config/systemd/user/trashquest-gateway.service" <<EOF
[Unit]
Description=TrashQuest camera, AI and ESP32 gateway
After=trashquest-backend.service trashquest-frontend.service

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

chmod +x "$ROOT/scripts/pi/start-trashquest.sh" "$ROOT/scripts/pi/stop-trashquest.sh" "$ROOT/scripts/pi/open-trashquest.sh" \
  "$ROOT/start-trashquest-pi.sh" "$ROOT/stop-trashquest-pi.sh"
cat >"$HOME/Desktop/TrashQuest Start.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Start
Comment=Start backend, frontend, and station hardware
Exec=$ROOT/scripts/pi/start-trashquest.sh --open
Icon=media-playback-start
Terminal=false
EOF
cat >"$HOME/Desktop/TrashQuest Stop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Stop
Comment=Stop backend, frontend, and station hardware when idle
Exec=$ROOT/scripts/pi/stop-trashquest.sh
Icon=media-playback-stop
Terminal=false
EOF
cat >"$HOME/Desktop/TrashQuest Open.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Open
Comment=Open the local touchscreen website
Exec=$ROOT/scripts/pi/open-trashquest.sh
Icon=web-browser
Terminal=false
EOF
cat >"$HOME/.config/autostart/trashquest-open.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Start at Login
Exec=$ROOT/scripts/pi/start-trashquest.sh --open
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
systemctl --user enable trashquest-backend.service trashquest-frontend.service trashquest-gateway.service
"$ROOT/scripts/pi/start-trashquest.sh"
printf '\n%s\n' 'Pi Start/Stop/Open icons are ready. All three services start on desktop login.'
printf '%s\n' 'The default browser opens the local website at desktop login.'
printf '%s\n' 'Check errors with: journalctl --user -u trashquest-backend -u trashquest-frontend -u trashquest-gateway -n 80 --no-pager'
