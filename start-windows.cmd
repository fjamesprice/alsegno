@echo off
REM alsegno - double-click launcher for Windows.
REM Runs the PowerShell installer (bypassing the execution policy for this one run): it checks
REM for Node + ffmpeg, prints install hints if either is missing, writes .env with a random
REM secret, and offers to start the app on boot. Leaves an existing .env untouched.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
