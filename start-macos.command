#!/usr/bin/env bash
# alsegno - double-click launcher for macOS. Finder runs .command files in Terminal.
# Runs the installer (first run: checks Node + ffmpeg, writes .env, optionally installs a boot
# service), then starts alsegno and opens it in your browser. If you didn't install a boot
# service, the app runs in THIS window - keep it open while you use alsegno, and press Ctrl+C
# (or close the window) to stop.
#
# First time: macOS may say it's from an "unidentified developer". Clear the download flag with
#   xattr -dr com.apple.quarantine .
# in this folder, or open System Settings > Privacy & Security and click "Open Anyway".
cd "$(dirname "$0")" || exit 1
./install.sh --launch "$@"
