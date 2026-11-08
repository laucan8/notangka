#!/usr/bin/env bash
cd "$(dirname "$0")"
if [[ ! -d .venv ]]; then echo "Jalankan dulu: bash setup_mac.sh"; exit 1; fi
source .venv/bin/activate
exec python app.py
