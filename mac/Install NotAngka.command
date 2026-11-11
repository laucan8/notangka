#!/usr/bin/env bash
# Double-click file ini di Finder untuk memasang NotAngka sebagai aplikasi Mac.
cd "$(dirname "$0")/.." || exit 1
git pull -q --ff-only 2>/dev/null || true
exec bash mac/install.sh
