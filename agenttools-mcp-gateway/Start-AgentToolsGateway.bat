@echo off
setlocal DisableDelayedExpansion
set "ROOT=%~dp0"
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if not exist "%NODE_EXE%" (
  echo ERROR: Trusted Node.js executable was not found: "%NODE_EXE%" 1>&2
  exit /b 1
)

if not exist "%ROOT%src\mcp\stdio-prototype.js" (
  echo ERROR: AgentTools Gateway MCP entry point was not found. 1>&2
  exit /b 1
)

cd /d "%ROOT%"
"%NODE_EXE%" "%ROOT%src\mcp\stdio-prototype.js"
exit /b %ERRORLEVEL%
