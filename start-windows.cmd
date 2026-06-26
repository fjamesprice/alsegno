@echo off
REM alsegno - double-click launcher for Windows.
REM Runs the installer (first run: installs Node if missing, checks ffmpeg, writes .env, optionally installs a boot
REM service), then starts alsegno and opens it in your browser. If you didn't install a boot
REM service, the app runs in THIS window - keep it open while you use alsegno, and close it (or
REM press Ctrl+C) to stop. If setup hits an error, the installer keeps the window open so you
REM can read it - there is no "press a key to close" that would discard the app.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Launch %*
