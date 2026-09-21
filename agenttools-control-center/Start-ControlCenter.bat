@echo off
setlocal
set "ROOT=%~dp0"
set "PUBLISHED=%ROOT%dist\AgentToolsControlCenter.exe"
set "RELEASE=%ROOT%bin\Release\net8.0-windows\AgentToolsControlCenter.exe"

if exist "%PUBLISHED%" (
  start "AgentTools Control Center" "%PUBLISHED%"
  exit /b 0
)

if exist "%RELEASE%" (
  start "AgentTools Control Center" "%RELEASE%"
  exit /b 0
)

echo Build output was not found. Running a Release build...
dotnet build "%ROOT%AgentToolsControlCenter.csproj" -c Release
if errorlevel 1 exit /b %errorlevel%
start "AgentTools Control Center" "%RELEASE%"
