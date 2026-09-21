@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Switch-CodexMode.ps1" -Mode ChatGPT %*
exit /b %errorlevel%
