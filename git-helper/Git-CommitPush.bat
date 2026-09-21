@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\git_commit_push.ps1" %*
exit /b %errorlevel%
