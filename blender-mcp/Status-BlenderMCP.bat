@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Manage-BlenderMCP.ps1" -Action Status %*
exit /b %errorlevel%
