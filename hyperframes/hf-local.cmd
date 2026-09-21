@echo off
setlocal
set HYPERFRAMES_NO_TELEMETRY=1
set DO_NOT_TRACK=1

rem HyperFrames skills auto-detection depends on the current directory.
rem Keep skill management anchored to this shared HyperFrames root so it does
rem not create .agents/.claude folders in the AgentTools root or sibling projects.
set "HF_PUSHED_DIR="
if /I "%~1"=="skills" (
    pushd "%~dp0"
    set "HF_PUSHED_DIR=1"
)

rem Keep the shared CLI deterministic instead of resolving an older cached npx package.
npx.cmd --yes hyperframes@0.8.23 %*
set "HF_EXIT_CODE=%ERRORLEVEL%"

if defined HF_PUSHED_DIR popd
exit /b %HF_EXIT_CODE%
