@echo off
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\Invoke-XRAutomation.ps1" %*
exit /b %ERRORLEVEL%
