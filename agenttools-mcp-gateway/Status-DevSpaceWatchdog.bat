@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
node src\cli.js watchdog status
echo.
node src\cli.js devspace health
echo.
pause
