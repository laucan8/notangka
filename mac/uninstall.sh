#!/usr/bin/env bash
# Hapus server otomatis + aplikasi NotAngka (folder kode & data tetap ada)
LABEL="com.notangka.server"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Applications/NotAngka.app"
echo "NotAngka.app dan server otomatis sudah dihapus. Hapus ikon di Dock secara manual jika masih ada."
