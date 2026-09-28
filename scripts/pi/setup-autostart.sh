#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
ACCOUNT="$(id -un)"
GROUP="$(id -gn)"
SYSTEMCTL="$(command -v systemctl)"
NODE="$(command -v node)"

if [[ $EUID -eq 0 ]]; then
  printf '%s\n' 'Run as your normal Pi user, not with sudo.' >&2
  exit 1
fi
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
command -v nginx >/dev/null || { printf '%s\n' 'Install nginx first.' >&2; exit 1; }
command -v npm >/dev/null || { printf '%s\n' 'Install Node.js and npm first.' >&2; exit 1; }

# Existing manually started processes would compete for the camera, serial
# port, or API port. Do not install over an active disposal.
state="$("$ROOT/.venv/bin/python" -c 'import json, urllib.request; print(json.load(urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=2)).get("workflowState", "UNKNOWN"))' 2>/dev/null || true)"
if [[ -n "$state" && "$state" != 'IDLE' ]]; then
  printf 'Station is %s. Finish the disposal before setup.\n' "$state" >&2
  exit 1
fi
if [[ -n "$state" ]] && ! systemctl is-active --quiet trashquest-gateway.service; then
  printf '%s\n' 'A manually started gateway is using port 8765. Stop it before setup.' >&2
  exit 1
fi
if curl --silent --max-time 2 http://127.0.0.1:5001/api/health >/dev/null 2>&1 \
   && ! systemctl is-active --quiet trashquest-backend.service; then
  printf '%s\n' 'A manually started backend is using port 5001. Stop it before setup.' >&2
  exit 1
fi

# Rebuild only the local Pi website; dependencies are reused.
(cd "$ROOT/Frontend" && npm run build)
sudo -v
sudo install -d -m 0755 /var/www/trashquest
sudo cp -a "$ROOT/Frontend/dist/." /var/www/trashquest/

# Keep a previously configured TrashQuest Nginx site. Create one on a fresh Pi.
if [[ ! -e /etc/nginx/sites-available/trashquest ]]; then
  sudo tee /etc/nginx/sites-available/trashquest >/dev/null <<'NGINX'
server {
    listen 80;
    server_name _;
    root /var/www/trashquest;
    index index.html;
    location /api/ {
        proxy_pass http://127.0.0.1:5001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX
fi
if [[ ! -e /etc/nginx/sites-enabled/trashquest ]]; then
  sudo ln -s /etc/nginx/sites-available/trashquest /etc/nginx/sites-enabled/trashquest
fi
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  sudo unlink /etc/nginx/sites-enabled/default
fi
sudo nginx -t

sudo tee /etc/systemd/system/trashquest-backend.service >/dev/null <<EOF
[Unit]
Description=TrashQuest backend API
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$ACCOUNT
Group=$GROUP
WorkingDirectory=$ROOT/Backend
Environment=NODE_ENV=production
ExecStart=$NODE src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo install -d -m 0755 -o "$ACCOUNT" -g "$GROUP" "$ROOT/.runtime/matplotlib" "$ROOT/.runtime/ultralytics"
sudo tee /etc/systemd/system/trashquest-gateway.service >/dev/null <<EOF
[Unit]
Description=TrashQuest camera, AI and ESP32 gateway
Wants=network-online.target trashquest-backend.service
After=network-online.target trashquest-backend.service

[Service]
Type=simple
User=$ACCOUNT
Group=$GROUP
WorkingDirectory=$ROOT
Environment=PYTHONUNBUFFERED=1
Environment=MPLCONFIGDIR=$ROOT/.runtime/matplotlib
Environment=YOLO_CONFIG_DIR=$ROOT/.runtime/ultralytics
ExecStart=$ROOT/.venv/bin/python $ROOT/station_gateway.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# The touch shortcuts can start/stop only these named units without a keyboard.
SUDOERS_TEMP="$(mktemp)"
trap 'rm -f -- "$SUDOERS_TEMP"' EXIT
printf '%s ALL=(root) NOPASSWD: %s start nginx.service, %s stop nginx.service, %s start trashquest-backend.service, %s stop trashquest-backend.service, %s start trashquest-gateway.service, %s stop trashquest-gateway.service\n' \
  "$ACCOUNT" "$SYSTEMCTL" "$SYSTEMCTL" "$SYSTEMCTL" "$SYSTEMCTL" "$SYSTEMCTL" "$SYSTEMCTL" >"$SUDOERS_TEMP"
sudo visudo -cf "$SUDOERS_TEMP"
sudo install -m 0440 "$SUDOERS_TEMP" /etc/sudoers.d/trashquest-touchscreen

chmod +x "$ROOT/scripts/pi/start-trashquest.sh" "$ROOT/scripts/pi/stop-trashquest.sh" "$ROOT/scripts/pi/open-trashquest.sh"
DESKTOP="$HOME/Desktop"
install -d -m 0755 "$DESKTOP" "$HOME/.config/autostart"
cat >"$DESKTOP/TrashQuest Start.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Start
Comment=Start local website, backend and gateway
Exec=$ROOT/scripts/pi/start-trashquest.sh --open
Icon=media-playback-start
Terminal=false
EOF
cat >"$DESKTOP/TrashQuest Stop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Stop
Comment=Stop TrashQuest after sorting is finished
Exec=$ROOT/scripts/pi/stop-trashquest.sh
Icon=media-playback-stop
Terminal=false
EOF
cat >"$DESKTOP/TrashQuest Open.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TrashQuest Open
Comment=Open local touchscreen website
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
chmod +x "$DESKTOP"/TrashQuest\ *.desktop "$HOME/.config/autostart/trashquest-open.desktop"
if command -v gio >/dev/null 2>&1; then
  for launcher in "$DESKTOP"/TrashQuest\ *.desktop; do
    gio set "$launcher" metadata::trusted true >/dev/null 2>&1 || true
  done
fi

sudo systemctl daemon-reload
sudo systemctl enable nginx.service trashquest-backend.service trashquest-gateway.service
sudo systemctl restart nginx.service trashquest-backend.service trashquest-gateway.service
printf '\n%s\n' 'TrashQuest now starts automatically at boot. The browser opens at desktop login.'
printf '%s\n' 'Touchscreen Start, Stop, and Open shortcuts are on the Pi desktop.'
printf '%s\n' 'Check failures with: sudo journalctl -u trashquest-gateway -u trashquest-backend -n 80 --no-pager'
