@echo off
setlocal
set "DOTNET=%ProgramFiles%\dotnet\dotnet.exe"
set "DLL=%~dp0bin\Release\net10.0-windows\AgentTools.WindowsUi.dll"
if not exist "%DOTNET%" (
  echo ERROR: dotnet.exe not found under %%ProgramFiles%%\dotnet 1>&2
  exit /b 1
)
if not exist "%DLL%" (
  echo ERROR: Windows UI helper is not built. Run Build-WindowsUi.bat first. 1>&2
  exit /b 2
)
"%DOTNET%" "%DLL%" %*
exit /b %ERRORLEVEL%
