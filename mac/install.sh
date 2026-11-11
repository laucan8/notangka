#!/usr/bin/env bash
# Pasang NotAngka sebagai aplikasi Mac (sekali saja):
#  - server NotAngka jalan otomatis di latar belakang setiap Mac menyala (LaunchAgent)
#  - aplikasi ~/Applications/NotAngka.app + ikon di Dock (klik = langsung terbuka)
#  - aplikasi ikut memperbarui diri dari GitHub saat dibuka
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.notangka.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/NotAngka.app"
LOG="$HOME/Library/Logs/NotAngka.log"
PORT="${NOTANGKA_PORT:-8765}"
URL="http://127.0.0.1:$PORT"
UID_N="$(id -u)"

say(){ printf "\n\033[1;34m==>\033[0m %s\n" "$1"; }
say "Memasang NotAngka dari $REPO"

case "$REPO" in
  "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
    echo "PERHATIAN: folder NotAngka ada di Desktop/Documents/Downloads. macOS bisa memblokir server latar belakang"
    echo "di folder itu. Disarankan pindahkan folder ke $HOME/notangka lalu jalankan pemasang lagi.";;
esac

# 1) Python env (pertama kali saja)
if [[ ! -x "$REPO/.venv/bin/python" ]]; then
  say "Setup pertama kali (unduh paket, ±10–20 menit)…"
  bash "$REPO/setup_mac.sh" --full || { echo "Setup gagal. Lihat pesan di atas."; exit 1; }
fi
say "Memastikan paket terbaru"
"$REPO/.venv/bin/pip" install -q -r "$REPO/requirements.txt" || true

# 2) Hentikan server lama (mis. dari ./run.sh) yang memakai port yang sama
OLD="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
[[ -n "$OLD" ]] && { say "Menghentikan server lama di port $PORT"; kill $OLD 2>/dev/null || true; sleep 1; }

# 3) LaunchAgent: server otomatis jalan & hidup kembali kalau berhenti
say "Mengaktifkan server otomatis (jalan sendiri saat Mac menyala)"
BREW_BIN="$(dirname "$(command -v brew 2>/dev/null || echo /opt/homebrew/bin/brew)")"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$REPO/.venv/bin/python</string><string>$REPO/app.py</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NOTANGKA_NO_BROWSER</key><string>1</string>
    <key>NOTANGKA_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$BREW_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true

# 4) Aplikasi NotAngka.app
say "Membuat aplikasi NotAngka di $APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$REPO/mac/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>NotAngka</string>
  <key>CFBundleDisplayName</key><string>NotAngka</string>
  <key>CFBundleIdentifier</key><string>com.notangka.app</string>
  <key>CFBundleExecutable</key><string>NotAngka</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
cat > "$APP/Contents/MacOS/NotAngka" <<EOF
#!/bin/bash
# Peluncur NotAngka: pastikan server hidup, buka jendela aplikasi, lalu cek pembaruan diam-diam.
REPO="$REPO"
URL="$URL"
LABEL="$LABEL"
LOG="$LOG"
alive(){ curl -s -m 1 "\$URL/api/health" >/dev/null 2>&1; }
if ! alive; then
  launchctl kickstart -k "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1 || \\
    (cd "\$REPO" && NOTANGKA_NO_BROWSER=1 nohup "\$REPO/.venv/bin/python" app.py >>"\$LOG" 2>&1 &)
  for i in \$(seq 1 60); do alive && break; sleep 0.5; done
fi
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="\$URL" --window-size=1400,920
else
  open "\$URL"
fi
# pembaruan otomatis dari GitHub (latar belakang)
(
  cd "\$REPO" || exit 0
  BEFORE=\$(git rev-parse HEAD 2>/dev/null)
  git pull -q --ff-only >/dev/null 2>&1 || exit 0
  AFTER=\$(git rev-parse HEAD 2>/dev/null)
  if [ "\$BEFORE" != "\$AFTER" ]; then
    "\$REPO/.venv/bin/pip" install -q -r "\$REPO/requirements.txt" >>"\$LOG" 2>&1
    launchctl kickstart -k "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1
  fi
) &
exit 0
EOF
chmod +x "$APP/Contents/MacOS/NotAngka"
touch "$APP"
# daftarkan ke Launchpad/Spotlight
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

# 5) Tambahkan ke Dock (sekali)
if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "NotAngka.app"; then
  say "Menambahkan NotAngka ke Dock"
  defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$APP/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  killall Dock 2>/dev/null || true
fi

# 6) Tunggu server siap lalu buka
say "Menunggu server siap…"
for i in $(seq 1 90); do curl -s -m 1 "$URL/api/health" >/dev/null 2>&1 && break; sleep 1; done
if curl -s -m 1 "$URL/api/health" >/dev/null 2>&1; then
  say "Selesai! Mulai sekarang cukup klik ikon NotAngka di Dock (atau Launchpad)."
  echo "Server jalan otomatis di latar belakang — link https://laucan8.github.io/notangka/ juga langsung terhubung."
  open "$APP"
else
  echo "Server belum merespons. Log: $LOG"
  tail -20 "$LOG" 2>/dev/null
fi
