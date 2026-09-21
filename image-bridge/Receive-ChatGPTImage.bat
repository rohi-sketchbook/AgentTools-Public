@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Receive-ChatGPTImage.ps1" -WorkspaceRoot "%AGENTTOOLS_WORKSPACE_ROOT%" %*
exit /b %errorlevel%
