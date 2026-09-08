@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.19 or later, then retry.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\initialize-local-data.mjs"
if errorlevel 1 goto failed
node.exe "%~dp0launcher.mjs"
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. See the message above and data\server-error.log.
pause
exit /b 1
