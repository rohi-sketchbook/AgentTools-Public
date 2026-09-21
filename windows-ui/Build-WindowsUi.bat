@echo off
setlocal
set "DOTNET=%ProgramFiles%\dotnet\dotnet.exe"
if not exist "%DOTNET%" (
  echo ERROR: dotnet.exe not found under %%ProgramFiles%%\dotnet 1>&2
  exit /b 1
)
"%DOTNET%" build "%~dp0AgentTools.WindowsUi.csproj" -c Release
exit /b %ERRORLEVEL%
