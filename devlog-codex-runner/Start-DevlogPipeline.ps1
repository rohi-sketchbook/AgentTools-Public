param(
    [string]$Date = ""
)

$ErrorActionPreference = "Stop"
$runnerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$entryPoint = Join-Path $runnerRoot "start-devlog-pipeline.mjs"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$arguments = @($entryPoint)

if (-not [string]::IsNullOrWhiteSpace($Date)) {
    $arguments += @("--date", $Date)
}

& $node @arguments
exit $LASTEXITCODE
