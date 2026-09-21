@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Import-BlenderTexture.ps1" -WorkspaceRoot "%AGENTTOOLS_WORKSPACE_ROOT%" %*
exit /b %errorlevel%
