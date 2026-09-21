param(
    [string]$Date = "",
    [switch]$Report,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$runnerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$entryPoint = Join-Path $runnerRoot "run-devlog-pipeline.mjs"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$arguments = @($entryPoint)

if (-not [string]::IsNullOrWhiteSpace($Date)) {
    $arguments += @("--date", $Date)
}
if ($Report) {
    $arguments += "--report"
}
if ($DryRun) {
    $arguments += "--dry-run"
}

& $node @arguments
exit $LASTEXITCODE
