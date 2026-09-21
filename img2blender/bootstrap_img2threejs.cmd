@echo off
setlocal
set "ROOT=%~dp0"
set "TARGET=%ROOT%tools\img2threejs"
set "REPO=https://github.com/img2threejs/img2threejs.git"

if exist "%TARGET%\.git" (
  echo img2threejs is already cloned at "%TARGET%"
  git -C "%TARGET%" rev-parse HEAD
  exit /b %ERRORLEVEL%
)

if exist "%TARGET%" (
  echo ERROR: target exists but is not a Git checkout: "%TARGET%"
  exit /b 2
)

git clone "%REPO%" "%TARGET%"
if errorlevel 1 exit /b %ERRORLEVEL%

git -C "%TARGET%" rev-parse HEAD
