#!/usr/bin/env bash
# Setup sekali jalan untuk macOS (Apple Silicon / Intel).
#   bash setup_mac.sh          -> inti (transkripsi not + chord)
#   bash setup_mac.sh --full   -> + Demucs (pisah vokal) + Whisper (lirik otomatis)  ~2 GB
set -euo pipefail
cd "$(dirname "$0")"
FULL=0; [[ "${1:-}" == "--full" ]] && FULL=1

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew belum terinstall. Install dulu dari https://brew.sh lalu jalankan ulang skrip ini."; exit 1
fi
echo "==> Install python@3.11, ffmpeg, deno (deno dibutuhkan yt-dlp untuk YouTube)"
brew install python@3.11 ffmpeg deno

PY="$(brew --prefix python@3.11)/bin/python3.11"
echo "==> Membuat virtualenv .venv"
"$PY" -m venv .venv
source .venv/bin/activate
python -m pip install -q -U pip wheel
echo "==> Install paket inti"
pip install -q -r requirements.txt
# basic-pitch dipasang tanpa dependensi bawaan (menghindari tensorflow); model ONNX dipakai via onnxruntime
pip install -q --no-deps basic-pitch==0.4.0
if [[ $FULL == 1 ]]; then
  echo "==> Install Demucs + Whisper (agak lama)"
  pip install -q -r requirements-extra.txt
fi
python - <<'PY'
import basic_pitch, librosa, yt_dlp, onnxruntime
print("OK — paket inti siap")
PY
chmod +x run.sh NotAngka.command 2>/dev/null || true
echo
echo "Selesai. Jalankan aplikasi:  ./run.sh   (atau double-click NotAngka.command)"
