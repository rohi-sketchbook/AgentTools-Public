[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
}
else {
    $ProjectRoot = (Resolve-Path $ProjectRoot).Path
}
$RunDirectory = Join-Path $ProjectRoot ".connect\run"
$SupervisorPidPath = Join-Path $RunDirectory "supervisor.pid"
$StopRequestPath = Join-Path $RunDirectory "stop.request"

New-Item -ItemType Directory -Force -Path $RunDirectory | Out-Null
Set-Content -Encoding ASCII -Path $StopRequestPath -Value ([DateTime]::UtcNow.ToString("O"))

if (-not (Test-Path $SupervisorPidPath)) {
    Write-Output "No managed supervisor PID file was found. Stop request has been recorded for any starting supervisor."
    exit 0
}

$supervisorPid = 0
if (-not [int]::TryParse((Get-Content -Raw $SupervisorPidPath).Trim(), [ref]$supervisorPid)) {
    Write-Output "Supervisor PID file was invalid. Stop request was recorded."
    exit 0
}

for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    $process = Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        Write-Output "Supervisor stopped. PID=$supervisorPid"
        exit 0
    }

    Start-Sleep -Seconds 1
}

Write-Warning "Supervisor did not stop within $TimeoutSeconds seconds. PID=$supervisorPid"
Write-Warning "No forced termination was performed."
exit 1
