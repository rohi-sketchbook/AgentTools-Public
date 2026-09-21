@echo off
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\Install-DevSpaceWatchdog.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to install DevSpace Watchdog.
  pause
  exit /b 1
)
echo.
echo DevSpace Watchdog is registered and started.
pause
