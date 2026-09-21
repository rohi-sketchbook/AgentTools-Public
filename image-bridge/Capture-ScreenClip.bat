@echo off
setlocal

set "SCRIPT=%~dp0scripts\Capture-ScreenClip.ps1"
set "WORKSPACE=%AGENTTOOLS_WORKSPACE_ROOT%"

if /I "%~1"=="--help" goto :help
if /I "%~1"=="/?" goto :help
if /I "%~1"=="-h" goto :help

if /I "%~1"=="--primary" (
  set "DELAY=%~3"
  if "%~3"=="" set "DELAY=0"
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode Primary -OutputPath "%~2" -DelaySeconds "%DELAY%" -WorkspaceRoot "%WORKSPACE%"
  exit /b %errorlevel%
)
if /I "%~1"=="--screen" (
  set "DELAY=%~4"
  if "%~4"=="" set "DELAY=0"
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode Screen -ScreenIndex "%~2" -OutputPath "%~3" -DelaySeconds "%DELAY%" -WorkspaceRoot "%WORKSPACE%"
  exit /b %errorlevel%
)
if /I "%~1"=="--window" (
  set "DELAY=%~4"
  if "%~4"=="" set "DELAY=0"
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode Window -WindowQuery "%~2" -OutputPath "%~3" -DelaySeconds "%DELAY%" -WorkspaceRoot "%WORKSPACE%"
  exit /b %errorlevel%
)
if /I "%~1"=="--list-windows" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode ListWindows -WorkspaceRoot "%WORKSPACE%"
  exit /b %errorlevel%
)
if /I "%~1"=="--all" (
  set "DELAY=%~3"
  if "%~3"=="" set "DELAY=0"
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode All -OutputPath "%~2" -DelaySeconds "%DELAY%" -WorkspaceRoot "%WORKSPACE%"
  exit /b %errorlevel%
)

set "DELAY=%~2"
if "%~2"=="" set "DELAY=0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode All -OutputPath "%~1" -DelaySeconds "%DELAY%" -WorkspaceRoot "%WORKSPACE%"
exit /b %errorlevel%

:help
echo Capture-ScreenClip.bat
echo.
echo Usage:
echo   Capture-ScreenClip.bat [--all^|--primary] [output_png] [delay_seconds]
echo   Capture-ScreenClip.bat --screen INDEX [output_png] [delay_seconds]
echo   Capture-ScreenClip.bat --window "window title or process" [output_png] [delay_seconds]
echo   Capture-ScreenClip.bat --list-windows
echo.
echo Workspace root is read from AGENTTOOLS_WORKSPACE_ROOT.
echo When omitted, the current working directory is used.
exit /b 0
