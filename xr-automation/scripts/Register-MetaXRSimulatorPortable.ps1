[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'AgentTools\MetaXRSimulator\v205.0')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$exe = Get-ChildItem -LiteralPath $Root -Filter 'MetaXRSimulator.exe' -Recurse -ErrorAction Stop | Select-Object -First 1
$runtime = Get-ChildItem -LiteralPath $Root -Filter 'meta_openxr_simulator.json' -Recurse -ErrorAction Stop | Select-Object -First 1
if ($null -eq $exe -or $null -eq $runtime) {
    throw "Portable Meta XR Simulator files were not found under $Root"
}
if ((Split-Path -Parent $exe.FullName) -ne (Split-Path -Parent $runtime.FullName)) {
    throw 'MetaXRSimulator.exe and meta_openxr_simulator.json must be in the same directory.'
}

$keyPath = 'HKCU:\Software\Classes\xrsim'
$commandPath = Join-Path $keyPath 'shell\open\command'
$backupPath = Join-Path $Root 'registration-backup.json'
$existingCommand = $null
if (Test-Path -LiteralPath $commandPath) {
    $existingCommand = (Get-Item -LiteralPath $commandPath).GetValue('')
}
if (-not (Test-Path -LiteralPath $backupPath)) {
    [pscustomobject]@{
        capturedAt = [DateTime]::UtcNow.ToString('o')
        existingCommand = $existingCommand
    } | ConvertTo-Json | Set-Content -LiteralPath $backupPath -Encoding UTF8
}

New-Item -Path $commandPath -Force | Out-Null
Set-ItemProperty -LiteralPath $keyPath -Name '(default)' -Value 'URL:Meta XR Simulator' -ErrorAction SilentlyContinue
New-ItemProperty -LiteralPath $keyPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -LiteralPath $commandPath -Value ('"' + $exe.FullName + '" %1')

$registered = (Get-Item -LiteralPath $commandPath).GetValue('')
[pscustomobject]@{
    ok = $registered -match [regex]::Escape($exe.FullName)
    executable = $exe.FullName
    runtimeJson = $runtime.FullName
    protocolCommand = $registered
    backup = $backupPath
} | ConvertTo-Json -Depth 4
