@echo off
setlocal

echo ========================================
echo  NUL file cleanup
echo ========================================
echo.
echo Each detected NUL file will ask for confirmation.
echo   y = delete
echo   n or Enter = keep
echo   q = quit
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove-nul-files.ps1" -Root "%~dp0." -Delete
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo Script exited with code %EXITCODE%.
) else (
    echo Finished.
)
echo.
pause
exit /b %EXITCODE%
