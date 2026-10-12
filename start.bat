@echo off
setlocal
cd /d "%~dp0"
rem vibe-seller-ts one-click start (repo dev mode): env check - install deps if needed -
rem launch server in a child window - wait until ready - open browser.
rem For distribution/daily use, use release\vibe-seller-ts\start.bat (npm run package).

where node >nul 2>nul
if errorlevel 1 (
  echo [start] Node.js not found. Install Node.js ^>= 22.5 first: https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo [start] First run: installing dependencies ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo [start] npm install failed. Check network / Node version ^>= 22.5.
    pause
    exit /b 1
  )
)

echo [start] Launching server in a child window ^(close that window or Ctrl+C to stop^)...
start "vibe-seller-ts" cmd /k "npm start"

echo [start] Waiting for http://127.0.0.1:7777 ...
powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{$r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7777/api/version -TimeoutSec 2;if($r.StatusCode -eq 200){exit 0}}catch{};Start-Sleep -Seconds 1};exit 1"
if errorlevel 1 (
  echo [start] Server not ready within 90s. Check the server window for errors
  echo         ^(common: port 7777 already in use, incomplete install^).
  pause
  exit /b 1
)

start "" http://127.0.0.1:7777/
echo [start] Opened http://127.0.0.1:7777/
echo [start] Default login: admin / admin -- change the password after first login.
endlocal
