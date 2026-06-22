#!/usr/bin/env bash
# alsegno - double-click launcher for macOS. Finder runs .command files in Terminal.
# Runs install.sh, which checks for Node + ffmpeg, prints install hints if either is missing,
# writes .env with a random secret, and offers to start the app on boot.
#
# First time: macOS may say it's from an "unidentified developer". Right-click the file,
# choose Open, then confirm — after that it double-clicks normally.
cd "$(dirname "$0")" || exit 1
./install.sh "$@"
