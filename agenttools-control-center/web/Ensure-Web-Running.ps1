[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'dist\AgentToolsControlCenter.Web.exe'
$port = 47832

if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Release build is required first: $exe"
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    } while (-not $listener -and (Get-Date) -lt $deadline)
}

if (-not $listener) {
    throw "Web dashboard did not listen on port $port."
}
if ($listener.LocalAddress -ne '127.0.0.1') {
    throw "Unexpected bind address: $($listener.LocalAddress)"
}

$health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 5
if ($health.ok -ne $true) {
    throw 'Web dashboard health check failed.'
}

Write-Host "Web dashboard is running: http://127.0.0.1:$port (PID $($listener.OwningProcess), loopback-only)"
