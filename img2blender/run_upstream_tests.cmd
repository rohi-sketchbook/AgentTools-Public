@echo off
setlocal
set "ROOT=%~dp0"
set "UPSTREAM=%ROOT%tools\img2threejs"

if not exist "%UPSTREAM%\.git" (
  echo ERROR: img2threejs upstream is not cloned.
  echo Run "%ROOT%bootstrap_img2threejs.cmd" first.
  exit /b 2
)

set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
python -B -m compileall -q "%UPSTREAM%\forge"
if errorlevel 1 exit /b %ERRORLEVEL%

pushd "%UPSTREAM%"
python -B -m unittest discover -s forge\tests -v
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
