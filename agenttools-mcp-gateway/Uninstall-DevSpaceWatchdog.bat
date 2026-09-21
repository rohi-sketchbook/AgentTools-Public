@echo off
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\Uninstall-DevSpaceWatchdog.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to uninstall DevSpace Watchdog.
  pause
  exit /b 1
)
echo.
pause
