[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$listener = Get-NetTCPConnection -State Listen -LocalPort 47832 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
    Write-Host 'Web dashboard is not running.'
    exit 0
}

$process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
if ($process.ProcessName -notlike 'AgentToolsControlCenter.Web*') {
    throw "Port 47832 is owned by an unexpected process: $($process.ProcessName) (PID $($process.Id))"
}

Stop-Process -Id $process.Id -ErrorAction Stop
$process.WaitForExit(5000) | Out-Null
Write-Host "Web dashboard stopped: PID $($process.Id)"
