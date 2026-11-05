@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Download Node.js 20+ from https://nodejs.org/
  pause
  exit /b 1
)
echo Starting Ludo Rewired server...
start "Ludo Rewired Server" cmd /k "cd /d ""%~dp0"" && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"
exit /b 0
