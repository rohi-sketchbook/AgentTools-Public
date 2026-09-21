@echo off
setlocal DisableDelayedExpansion
set "ROOT=%~dp0"
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if not exist "%NODE_EXE%" (
  echo ERROR: Trusted Node.js executable was not found: "%NODE_EXE%" 1>&2
  exit /b 1
)

cd /d "%ROOT%"
echo === AgentTools Gateway ===
"%NODE_EXE%" "%ROOT%src\cli.js" gateway health
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo === DevSpace through Gateway ===
"%NODE_EXE%" "%ROOT%src\cli.js" devspace health
exit /b %ERRORLEVEL%
