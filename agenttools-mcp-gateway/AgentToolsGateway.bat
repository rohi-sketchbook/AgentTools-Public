@echo off
setlocal DisableDelayedExpansion
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  echo AgentTools Gateway: trusted Node.js executable not found: "%NODE_EXE%" 1>&2
  exit /b 1
)
"%NODE_EXE%" "%~dp0src\cli.js" %*
