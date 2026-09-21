[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$bridgeSupervisor = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\discord-codex-bridge\run-localized-bot-supervisor.ps1"))

if (-not (Test-Path -LiteralPath $bridgeSupervisor)) {
    throw "Discord bridge supervisor was not found: $bridgeSupervisor"
}

Write-Output "Delegating to Discord Remote Control / ChatGPT Bridge supervisor."
& $bridgeSupervisor
exit $LASTEXITCODE
