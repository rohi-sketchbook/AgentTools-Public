@echo off
call "%~dp0XRAutomation.bat" metavr-mcp --no-telemetry %*
exit /b %ERRORLEVEL%
